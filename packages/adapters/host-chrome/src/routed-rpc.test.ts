import { describe, expect, it } from "vitest";
import { createSwPortRouter } from "./router-port";
import { connectRouted, createSwService } from "./routed-rpc";
import { InMemoryTranscriptStore } from "@gpt-sidekick/core/store";
import { RulesExtractor } from "@gpt-sidekick/core/extractor";
import {
  fetchConversationId,
  onJumpRequested,
  onJumpResult,
  fetchOutline,
  onOutlineChanged,
  pushTranscript,
  reportJumpResult,
  requestReindex,
  requestSourceJump,
  onReindexRequested,
  registerStoreService,
} from "@gpt-sidekick/core/service";
import type { Address } from "@gpt-sidekick/core/router";
import type { TranscriptEvent } from "@gpt-sidekick/core/model";

const EXT_ID = "ext-id";

type MsgListener = (message: unknown, port: LinkedPort) => void;
type DisconnectListener = (port: LinkedPort) => void;

/** One end of a connected port pair: postMessage here fires onMessage on the peer. */
class LinkedPort {
  peer!: LinkedPort;
  readonly msgListeners: MsgListener[] = [];
  readonly disconnectListeners: DisconnectListener[] = [];

  constructor(
    public readonly name: string,
    public readonly sender?: chrome.runtime.MessageSender,
  ) {}

  readonly onMessage = {
    addListener: (l: MsgListener) => this.msgListeners.push(l),
  };
  readonly onDisconnect = {
    addListener: (l: DisconnectListener) => this.disconnectListeners.push(l),
  };
  readonly postMessage = (message: unknown): void => {
    for (const l of this.peer.msgListeners) l(message, this.peer);
  };
  readonly disconnect = (): void => {
    for (const l of this.peer.disconnectListeners) l(this.peer);
  };
}

function makePair(name: string, sender?: chrome.runtime.MessageSender) {
  const client = new LinkedPort(name); // client end — its sender is the SW's view
  const sw = new LinkedPort(name, sender);
  client.peer = sw;
  sw.peer = client;
  return { client, sw };
}

function fakeChrome() {
  const swConnectListeners: ((port: chrome.runtime.Port) => void)[] = [];
  let nextSender: chrome.runtime.MessageSender | undefined;
  return {
    runtime: {
      id: EXT_ID,
      onConnect: {
        addListener: (cb: (port: chrome.runtime.Port) => void) =>
          swConnectListeners.push(cb),
      },
      connect: (info?: { name?: string }) => {
        const { client, sw } = makePair(info?.name ?? "", nextSender);
        for (const cb of swConnectListeners) cb(sw as unknown as chrome.runtime.Port);
        return client as unknown as chrome.runtime.Port;
      },
    },
    connectAs<T>(sender: chrome.runtime.MessageSender, fn: () => T): T {
      nextSender = sender;
      try {
        return fn();
      } finally {
        nextSender = undefined;
      }
    },
  };
}

const contentSender = (tabId: number): chrome.runtime.MessageSender => ({
  id: EXT_ID,
  tab: { id: tabId } as chrome.tabs.Tab,
});
const panelSender = (): chrome.runtime.MessageSender => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/sidepanel.html`,
});
const panel = (tabId: number): Address => ({ context: "panel", tabId });

const codeEvent = (messageId: string, turnIndex: number): TranscriptEvent => ({
  provider: "chatgpt",
  conversationId: "c1",
  messageId,
  role: "assistant",
  text: "Here is the fix:\n```\nconst x = 1;\n```\n",
  turnIndex,
  messageIndex: 0,
  anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
});

/** SW router + service echoing back its request payload and attested source. */
function pingSetup() {
  const fc = fakeChrome();
  const router = createSwPortRouter(fc.runtime);
  const svc = createSwService(router);
  svc.handle("ping", (payload) => ({ pong: payload }));
  svc.handle("whoami", (_payload, source) => source);
  return { fc, svc, router };
}

describe("routed RPC / SW service — client ⇄ router ⇄ source-aware handler", () => {
  it("round-trips a content request through the SW router", async () => {
    const { fc } = pingSetup();
    const rpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    expect(await rpc.request("ping", "hi")).toEqual({ pong: "hi" });
  });

  it("round-trips a panel request after its hello handshake", async () => {
    const { fc } = pingSetup();
    const rpc = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 7 }, fc.runtime),
    );
    expect(await rpc.request("ping", "yo")).toEqual({ pong: "yo" });
  });

  it("routes each reply to its own caller when two are connected (correlation)", async () => {
    const { fc } = pingSetup();
    const content = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    const panel3 = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 3 }, fc.runtime),
    );
    const [a, b] = await Promise.all([
      content.request("ping", "seven"),
      panel3.request("ping", "three"),
    ]);
    expect(a).toEqual({ pong: "seven" });
    expect(b).toEqual({ pong: "three" });
  });

  it("gives handlers the Chrome-attested source, not the caller's claim", async () => {
    const { fc } = pingSetup();
    const rpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    expect(await rpc.request("whoami", null)).toEqual({ context: "content", tabId: 7 });
  });

  it("pushes a one-way notification from the SW to a specific panel", async () => {
    const { fc, svc } = pingSetup();
    const panelRpc = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 7 }, fc.runtime),
    );
    let resolve: (v: unknown) => void;
    const got = new Promise((r) => (resolve = r));
    panelRpc.handle("notify", (payload) => resolve(payload));

    svc.push(panel(7), "notify", { hello: "world" });

    expect(await got).toEqual({ hello: "world" });
  });

  it("does not throw the router loop when a handler rejects (error reply)", async () => {
    const { fc, svc } = pingSetup();
    svc.handle("boom", () => {
      throw new Error("kaboom");
    });
    const rpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    await expect(rpc.request("boom", null)).rejects.toThrow("kaboom");
  });

  it("end to end: content push → index → SW notifies the panel → panel fetches outline", async () => {
    const fc = fakeChrome();
    const router = createSwPortRouter(fc.runtime);
    const svc = createSwService(router);
    registerStoreService(svc, new InMemoryTranscriptStore(() => "T"), RulesExtractor);

    const panelRpc = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 7 }, fc.runtime),
    );
    let resolveChanged: (cid: string) => void;
    const changed = new Promise<string>((r) => (resolveChanged = r));
    onOutlineChanged(panelRpc, (cid) => resolveChanged(cid));

    const contentRpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    const result = await pushTranscript(contentRpc, [codeEvent("m1", 0)]);
    expect(result.items).toBeGreaterThanOrEqual(1);

    expect(await changed).toBe("c1"); // the panel for tab 7 was notified
    expect(await fetchConversationId(panelRpc)).toBe("c1");
    expect(await fetchOutline(panelRpc, "c1")).toHaveLength(result.items);
  });

  it("end to end: panel re-index + source-jump commands stay scoped to its content tab", async () => {
    const fc = fakeChrome();
    const router = createSwPortRouter(fc.runtime);
    const svc = createSwService(router);
    registerStoreService(svc, new InMemoryTranscriptStore(() => "T"), RulesExtractor, {
      newId: () => "jump-1",
    });

    const contentRpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    const panelRpc = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 7 }, fc.runtime),
    );
    await pushTranscript(contentRpc, [
      { ...codeEvent("m1", 0), turnId: "turn-1" },
    ]);

    let resolveReindex: () => void;
    const reindexed = new Promise<void>((resolve) => (resolveReindex = resolve));
    onReindexRequested(contentRpc, () => resolveReindex());
    expect(await requestReindex(panelRpc)).toEqual({ accepted: true });
    await reindexed;

    onJumpRequested(contentRpc, async (request) => {
      expect(request).toEqual({
        requestId: "jump-1",
        messageId: "m1",
        turnId: "turn-1",
      });
      await reportJumpResult(contentRpc, {
        requestId: request.requestId,
        status: "found",
      });
    });
    let resolveJump: (status: string) => void;
    const jumped = new Promise<string>((resolve) => (resolveJump = resolve));
    onJumpResult(panelRpc, (result) => resolveJump(result.status));

    expect(await requestSourceJump(panelRpc, "c1", "m1")).toEqual({
      status: "relocating",
      requestId: "jump-1",
    });
    expect(await jumped).toBe("found");
  });
});

import { describe, expect, it } from "vitest";
import { createSwPortRouter } from "./router-port";
import { connectRouted, createSwRoutedRpc } from "./routed-rpc";

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
    /** Attribute the SW-side sender for connects made inside `fn`. */
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
const panelSender = (): chrome.runtime.MessageSender => ({ id: EXT_ID });

function setup() {
  const fc = fakeChrome();
  const router = createSwPortRouter(fc.runtime);
  const swRpc = createSwRoutedRpc(router);
  swRpc.handle("ping", (payload) => ({ pong: payload }));
  return fc;
}

describe("routed RPC end to end — client ⇄ SW router ⇄ handler", () => {
  it("round-trips a content request through the SW router", async () => {
    const fc = setup();
    const rpc = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    expect(await rpc.request("ping", "hi")).toEqual({ pong: "hi" });
  });

  it("round-trips a panel request after its hello handshake", async () => {
    const fc = setup();
    const rpc = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 7 }, fc.runtime),
    );
    expect(await rpc.request("ping", "yo")).toEqual({ pong: "yo" });
  });

  it("routes each reply to its own caller when two are connected (id correlation)", async () => {
    const fc = setup();
    const content = fc.connectAs(contentSender(7), () =>
      connectRouted({ context: "content" }, fc.runtime),
    );
    const panel = fc.connectAs(panelSender(), () =>
      connectRouted({ context: "panel", tabId: 3 }, fc.runtime),
    );

    const [a, b] = await Promise.all([
      content.request("ping", "seven"),
      panel.request("ping", "three"),
    ]);
    expect(a).toEqual({ pong: "seven" });
    expect(b).toEqual({ pong: "three" });
  });
});

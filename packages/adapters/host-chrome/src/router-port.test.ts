import { describe, expect, it } from "vitest";
import { createSwPortRouter } from "./router-port";
import type { Address, RoutedEnvelope } from "@gpt-sidekick/core/router";
import type { Envelope } from "@gpt-sidekick/core/protocol";

const EXT_ID = "ext-id";

type MsgListener = (message: unknown, port: FakePort) => void;
type DisconnectListener = (port: FakePort) => void;

/** Minimal stand-in for a `chrome.runtime.Port` we can drive from both ends. */
class FakePort {
  private readonly messageListeners: MsgListener[] = [];
  private readonly disconnectListeners: DisconnectListener[] = [];
  readonly posted: unknown[] = [];
  disconnected = false;
  /** When true, `postMessage` throws — simulates Chrome's "disconnected port". */
  failPost = false;

  constructor(
    public readonly name: string,
    public readonly sender?: chrome.runtime.MessageSender,
  ) {}

  readonly onMessage = {
    addListener: (l: MsgListener) => this.messageListeners.push(l),
  };
  readonly onDisconnect = {
    addListener: (l: DisconnectListener) => this.disconnectListeners.push(l),
  };
  readonly postMessage = (message: unknown): void => {
    if (this.failPost) throw new Error("Attempting to use a disconnected port object");
    this.posted.push(message);
  };
  readonly disconnect = (): void => {
    this.disconnected = true;
    for (const l of this.disconnectListeners) l(this);
  };

  /** Simulate the far end sending us a message. */
  emit(message: unknown): void {
    for (const l of this.messageListeners) l(message, this);
  }
}

function fakeRuntime() {
  const connectListeners: ((port: chrome.runtime.Port) => void)[] = [];
  return {
    runtime: {
      id: EXT_ID,
      onConnect: {
        addListener: (cb: (port: chrome.runtime.Port) => void) =>
          connectListeners.push(cb),
      },
    },
    connect(port: FakePort) {
      for (const cb of connectListeners) cb(port as unknown as chrome.runtime.Port);
    },
  };
}

const contentSender = (tabId: number): chrome.runtime.MessageSender => ({
  id: EXT_ID,
  url: "https://chatgpt.com/c/abc", // a content script reports the web page URL
  tab: { id: tabId } as chrome.tabs.Tab,
});
const panelSender = (): chrome.runtime.MessageSender => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/sidepanel.html`, // a real panel is our page
});

const env = (kind = "pushTranscript"): Envelope => ({ id: "e1", kind, payload: "x" });
const routed = (
  target: Address,
  envelope: Envelope,
  source: Address = { context: "sw" },
): RoutedEnvelope => ({ source, target, envelope });

function connectPanel(rt: ReturnType<typeof fakeRuntime>, tabId: number): FakePort {
  const port = new FakePort(PANEL, panelSender());
  rt.connect(port);
  port.emit({ kind: "hello", tabId });
  return port;
}
function connectContent(rt: ReturnType<typeof fakeRuntime>, tabId: number): FakePort {
  const port = new FakePort(CONTENT, contentSender(tabId));
  rt.connect(port);
  return port;
}

const CONTENT = "gpt-sidekick:content";
const PANEL = "gpt-sidekick:panel";

describe("createSwPortRouter — chrome ports bound to the pure router", () => {
  it("routes a content push to its own panel and no other tab's panel", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const panel7 = connectPanel(rt, 7);
    const panel3 = connectPanel(rt, 3);
    const content7 = connectContent(rt, 7);

    // Declared source lies (tab 999); attested tab is 7 from port.sender.tab.id.
    content7.emit(
      routed({ context: "panel", tabId: 7 }, env(), { context: "content", tabId: 999 }),
    );

    expect(panel7.posted).toHaveLength(1);
    expect(panel3.posted).toHaveLength(0); // §13: no cross-panel leak
    const delivered = panel7.posted[0] as RoutedEnvelope;
    expect(delivered.source).toEqual({ context: "content", tabId: 7 }); // attested wins
    expect(delivered.envelope.kind).toBe("pushTranscript");
  });

  it("blocks a content script from addressing another tab's panel", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const panel3 = connectPanel(rt, 3);
    const content7 = connectContent(rt, 7);

    content7.emit(routed({ context: "panel", tabId: 3 }, env()));

    expect(panel3.posted).toHaveLength(0);
  });

  it("disconnects a port whose sender is not this extension", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const foreign = new FakePort(CONTENT, {
      id: "some-other-extension",
      tab: { id: 7 } as chrome.tabs.Tab,
    });
    rt.connect(foreign);
    expect(foreign.disconnected).toBe(true);
  });

  it("fails closed on a content port with no attested tab id", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const noTab = new FakePort(CONTENT, { id: EXT_ID }); // sender.tab undefined
    rt.connect(noTab);
    expect(noTab.disconnected).toBe(true);
  });

  it("disconnects an unknown port name", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const weird = new FakePort("gpt-sidekick:evil", { id: EXT_ID });
    rt.connect(weird);
    expect(weird.disconnected).toBe(true);
  });

  it("rejects a PANEL_PORT connection that carries an attested tab (content masquerade)", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    // A content script can open a panel-named port, but it reports the web
    // page's URL (not our extension page), so it can't mint a panel identity.
    const masquerade = new FakePort(PANEL, contentSender(7));
    rt.connect(masquerade);
    expect(masquerade.disconnected).toBe(true);
  });

  it("disconnects a panel whose first message is not a valid hello", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const badPanel = new FakePort(PANEL, panelSender());
    rt.connect(badPanel);
    badPanel.emit({ kind: "not-hello" });
    expect(badPanel.disconnected).toBe(true);
  });

  it("does not let a disconnected target's postMessage throw abort routing", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const panel7 = connectPanel(rt, 7);
    const content7 = connectContent(rt, 7);
    // The panel port was torn down between the push and its onDisconnect firing.
    panel7.failPost = true;

    expect(() =>
      content7.emit(routed({ context: "panel", tabId: 7 }, env())),
    ).not.toThrow();
  });

  it("stops delivering to a panel after it disconnects", () => {
    const rt = fakeRuntime();
    createSwPortRouter(rt.runtime);
    const panel7 = connectPanel(rt, 7);
    const content7 = connectContent(rt, 7);

    panel7.disconnect();
    content7.emit(routed({ context: "panel", tabId: 7 }, env()));

    expect(panel7.posted).toHaveLength(0);
  });
});

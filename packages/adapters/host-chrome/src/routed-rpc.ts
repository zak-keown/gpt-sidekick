import {
  createRpc,
  type Envelope,
  type Rpc,
  type Transport,
} from "@gpt-sidekick/core/protocol";
import type {
  Address,
  Link,
  Router,
} from "@gpt-sidekick/core/router";
import { CONTENT_PORT, PANEL_PORT } from "./router-port";

/**
 * Correlation-ID RPC over the §13 targeted router.
 *
 * `connectRouted` gives a content script or side panel an `Rpc` whose every call
 * is relayed by the SW to only its addressed endpoint (never broadcast); it
 * inherits the M0 RPC correctness (unique ids, timeout) on top of the router's
 * attested/firewalled delivery. `createSwRoutedRpc` is the SW's side: it handles
 * routed requests and sends each reply back to exactly the source that issued it.
 *
 * This is the content-bearing transport the M0 broadcast `createChromeRpc`
 * explicitly must NOT carry (see transport.ts) — transcript/outline/source-jump
 * payloads ride here.
 */

const SW: Address = { context: "sw" };
const DEFAULT_TIMEOUT_MS = 5_000;

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).id === "string" &&
    typeof (value as Envelope).kind === "string"
  );
}

const timerOptions = {
  newId: () => crypto.randomUUID(),
  setTimer: (fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
};

/** The minimal `chrome.runtime` surface a client needs to connect. */
type ConnectRuntime = {
  connect(info: { name: string }): chrome.runtime.Port;
};

/**
 * Connect a non-SW context to the SW router and get an `Rpc` relayed to the
 * service worker. Content scripts are Chrome-attested, so they just connect;
 * panels are extension pages with no attested tab, so they announce their tab id
 * in a `hello` that MUST be the first message on the port (the SW's
 * `resolvePanelIdentity` treats the first message as the hello and disconnects
 * anything else) — so we send it here, synchronously, before any RPC call.
 */
export function connectRouted(
  self: { context: "content" } | { context: "panel"; tabId: number },
  runtime: ConnectRuntime = chrome.runtime,
): Rpc {
  const name = self.context === "content" ? CONTENT_PORT : PANEL_PORT;
  const port = runtime.connect({ name });
  if (self.context === "panel") {
    port.postMessage({ kind: "hello", tabId: self.tabId });
  }

  const transport: Transport = {
    // Address every call to the SW; it stamps our attested source and relays.
    // We deliberately do NOT declare our own source — the SW attests it.
    send: (envelope) => port.postMessage({ target: SW, envelope }),
    onMessage: (listener) => {
      port.onMessage.addListener((message: unknown) => {
        const envelope = (message as { envelope?: unknown }).envelope;
        if (isEnvelope(envelope)) listener(envelope);
      });
    },
  };

  return createRpc(transport, timerOptions);
}

/**
 * The service-worker side of the routed RPC. Registers an SW endpoint on the
 * router and returns an `Rpc` to `handle(...)` on (e.g. via
 * `registerStoreService`). Requests arrive already routed (attested source,
 * firewalled); each reply is sent back to whichever source issued the matching
 * request, correlated by envelope id — so concurrent callers never cross replies.
 */
export function createSwRoutedRpc(router: Router): Rpc {
  const replyTarget = new Map<string, Address>();
  let deliverToRpc: ((envelope: Envelope) => void) | undefined;

  const swLink: Link = {
    attested: SW,
    deliver: (routed) => {
      // Remember where a request came from so its reply routes back there.
      if (!routed.envelope.kind.endsWith(":reply")) {
        replyTarget.set(routed.envelope.id, routed.source);
      }
      deliverToRpc?.(routed.envelope);
    },
  };
  router.addLink(swLink);

  const transport: Transport = {
    send: (envelope) => {
      const target = replyTarget.get(envelope.id);
      replyTarget.delete(envelope.id);
      if (target) router.route(swLink, { source: SW, target, envelope });
    },
    onMessage: (listener) => {
      deliverToRpc = listener;
    },
  };

  return createRpc(transport, timerOptions);
}

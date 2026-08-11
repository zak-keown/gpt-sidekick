import {
  buildErrorReply,
  buildReply,
  createRpc,
  REPLY_SUFFIX,
  type Envelope,
  type Rpc,
  type Transport,
} from "@gpt-sidekick/core/protocol";
import type { Address, Link, Router } from "@gpt-sidekick/core/router";
import type { StoreServiceHost } from "@gpt-sidekick/core/service";
import { CONTENT_PORT, PANEL_PORT } from "./router-port";

/**
 * Content-bearing transport over the §13 targeted router — the payload path the
 * M0 broadcast `createChromeRpc` explicitly must NOT carry (see transport.ts).
 *
 * `connectRouted` gives a content script or side panel an `Rpc` relayed by the
 * SW to only its addressed endpoint (never broadcast), inheriting the M0 RPC
 * correctness on top of the router's attested/firewalled delivery.
 *
 * `createSwService` is the SW's side. Unlike a plain `Rpc`, its handlers receive
 * the Chrome-attested `source` (so the store service can notify the right tab's
 * panel and map tab→conversation), and it can `push` a one-way notification to a
 * target. A single `swLink` backs both, so a request to `sw` is delivered once.
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
 * anything else) — so we send it on every connection, before any RPC call.
 *
 * SURVIVING THE SW LIFECYCLE. MV3 reclaims an idle service worker (~30 s), so
 * every client OUTLIVES the SW it connected to. A one-shot `runtime.connect`
 * therefore rots: the port dies with the SW and every later `postMessage`
 * throws "Attempting to use a disconnected port object" forever, so capture
 * silently stops for the life of the tab and the SW's ephemeral
 * `tab → conversation` map can never be repopulated (observed live 2026-08-11,
 * findings/2026-08-11_spike-live-test.md). We reconnect instead — LAZILY, on
 * the next send, so we never hold the SW awake merely to keep a socket open.
 * The first connection is still eager, so the SW can reach an idle client
 * (re-index / jump commands) before it has sent anything.
 *
 * Residual: between the SW dying and this client's next send, an SW→client
 * push has no route and is dropped. Reads are unaffected (the panel refetches
 * on its next interaction, which is itself a send), and no state is lost —
 * the durable data lives in the store.
 */
export function connectRouted(
  self: { context: "content" } | { context: "panel"; tabId: number },
  runtime: ConnectRuntime = chrome.runtime,
): Rpc {
  const name = self.context === "content" ? CONTENT_PORT : PANEL_PORT;
  let port: chrome.runtime.Port | undefined;
  let deliver: ((envelope: Envelope) => void) | undefined;

  const open = (): chrome.runtime.Port => {
    const fresh = runtime.connect({ name });
    // Re-announce on EVERY connection: a fresh SW instance has no memory of an
    // earlier hello, and without one it disconnects the port as a bad handshake.
    if (self.context === "panel") {
      fresh.postMessage({ kind: "hello", tabId: self.tabId });
    }
    fresh.onMessage.addListener((message: unknown) => {
      const envelope = (message as { envelope?: unknown }).envelope;
      if (isEnvelope(envelope)) deliver?.(envelope);
    });
    fresh.onDisconnect.addListener(() => {
      if (port === fresh) port = undefined; // next send opens a new one
    });
    port = fresh;
    return fresh;
  };

  const transport: Transport = {
    // Address every call to the SW; it stamps our attested source and relays.
    // We deliberately do NOT declare our own source — the SW attests it.
    send: (envelope) => {
      const routed = { target: SW, envelope };
      try {
        (port ?? open()).postMessage(routed);
      } catch {
        // The port died before its `onDisconnect` reached us. Retry once on a
        // fresh connection; a second throw surfaces to the caller's RPC.
        port = undefined;
        open().postMessage(routed);
      }
    },
    onMessage: (listener) => {
      deliver = listener;
    },
  };

  const rpc = createRpc(transport, timerOptions);
  open(); // eager first connect: keeps the client reachable while idle
  return rpc;
}

/**
 * The service-worker side of the routed RPC. Registers an SW endpoint on the
 * router and returns a `StoreServiceHost` to bind handlers on (via
 * `registerStoreService`). Requests arrive already routed (attested source,
 * firewalled); each reply is sent straight back to the source that issued it —
 * the source is captured per delivery, so concurrent callers never cross replies.
 * A throwing handler becomes an error reply (async-wrapped), never a throw out of
 * the router's synchronous delivery loop.
 */
export function createSwService(router: Router): StoreServiceHost {
  const handlers = new Map<
    string,
    (payload: unknown, source: Address) => unknown | Promise<unknown>
  >();

  const swLink: Link = {
    attested: SW,
    deliver: (routed) => {
      const env = routed.envelope;
      if (env.kind.endsWith(REPLY_SUFFIX)) return; // the SW consumes no replies
      const handler = handlers.get(env.kind);
      if (!handler) return;
      const source = routed.source; // attested; captured for this delivery only
      void Promise.resolve()
        .then(() => handler(env.payload, source))
        .then(
          (reply) =>
            router.route(swLink, {
              source: SW,
              target: source,
              envelope: buildReply(env.id, env.kind, reply),
            }),
          (err) =>
            router.route(swLink, {
              source: SW,
              target: source,
              envelope: buildErrorReply(env.id, env.kind, err),
            }),
        );
    },
  };
  router.addLink(swLink);

  return {
    handle: (kind, fn) => {
      handlers.set(kind, fn);
    },
    push: (target, kind, payload) => {
      router.route(swLink, {
        source: SW,
        target,
        envelope: { id: crypto.randomUUID(), kind, payload },
      });
    },
  };
}

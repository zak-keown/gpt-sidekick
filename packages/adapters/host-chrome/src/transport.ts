import {
  createRpc,
  type Envelope,
  type Rpc,
  type Transport,
} from "@gpt-sidekick/core/protocol";

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).id === "string" &&
    typeof (value as Envelope).kind === "string"
  );
}

/**
 * `chrome.runtime` implementation of core's one-way transport LCD.
 *
 * `runtime.sendMessage` broadcasts to every extension context except the
 * sender, so the same transport works from the side panel and the service
 * worker. Fire-and-forget: a send with no listener yet rejects with
 * "receiving end does not exist", which we swallow — the caller's RPC timeout
 * (see `createChromeRpc`) is the backstop, so a dead receiver degrades to a
 * bounded wait rather than a hang.
 */
export function createChromeRuntimeTransport(): Transport {
  return {
    send: (envelope) => {
      void chrome.runtime.sendMessage(envelope).catch(() => {});
    },
    onMessage: (listener) => {
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (isEnvelope(message)) listener(message);
      });
    },
  };
}

/** Bounded wait for a Chrome RPC round-trip; keeps a UI action from hanging on a dead SW. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The one blessed way to construct an RPC in a Chrome extension context.
 *
 * Wires the runtime transport + globally-unique ids (`crypto.randomUUID`) + a
 * real timer together, so a collision-prone or timeout-less RPC isn't
 * constructible at a call site. Always prefer this over calling `createRpc`
 * with `createChromeRuntimeTransport()` directly.
 *
 * ⚠️ ECHO-ONLY. This rides `runtime.sendMessage` *broadcast*: unique ids stop
 * reply mis-resolution, but every reply still reaches every context's memory. Do
 * NOT send transcript/outline/source-jump payloads through this — those go over
 * the §13 targeted router (`./router` → `createSwPortRouter`, core's `Router`),
 * which relays each payload to only its own tab's panel.
 */
export function createChromeRpc(): Rpc {
  return createRpc(createChromeRuntimeTransport(), {
    newId: () => crypto.randomUUID(),
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    },
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

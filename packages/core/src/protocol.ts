/**
 * Correlation-ID RPC layered over a one-way JSON message transport.
 *
 * The transport LCD is deliberately minimal — `send` + `onMessage` — because
 * every host (chrome.runtime, ports, in-memory test fakes) can provide it.
 * This module stays pure and DOM/Chrome-free; hosts inject platform primitives
 * (id source, timer) through options.
 *
 * Routing model (why unique ids matter): `chrome.runtime.sendMessage`
 * broadcasts to every extension context except the sender, so a reply reaches
 * *every* RPC instance, not just the caller. Request ids must therefore be
 * globally unique across contexts — otherwise two contexts whose first request
 * collides (both `rpc-0`) can resolve each other's replies. See the default id
 * factory and `RpcOptions.newId`.
 *
 * NOTE (deferred to M1, tracked in SPEC §13): unique ids stop mis-*resolution*,
 * not broadcast *exposure* — a reply still reaches every context's memory. That
 * is harmless for echo strings but becomes a privacy/tenant bug once real
 * transcript/outline payloads flow. Targeted/port routing is an M1-blocking
 * item before those payloads go over the wire.
 */

export type Envelope = {
  id: string;
  kind: string;
  payload?: unknown;
  /** Present only on a reply produced by a failed handler. */
  error?: string;
};

export type Transport = {
  send: (envelope: Envelope) => void;
  onMessage: (listener: (envelope: Envelope) => void) => void;
};

/** Cancels a scheduled timer. */
export type CancelTimer = () => void;

export type RequestOptions = {
  /** Overrides `RpcOptions.defaultTimeoutMs` for this call. */
  timeoutMs?: number;
};

export type RpcOptions = {
  /**
   * Produces a request id that MUST be unique across every context sharing the
   * transport. Defaults to a per-instance random prefix + counter (safe across
   * contexts by construction); hosts may inject a stronger source such as
   * `crypto.randomUUID`. Do NOT replace this with a bare per-instance counter —
   * two contexts would both start at the same id and cross-resolve.
   */
  newId?: () => string;
  /**
   * Schedules a one-shot timer, returning a cancel handle. Injected so core
   * stays clock-free (its lib has no `setTimeout`). Omit to disable timeouts.
   */
  setTimer?: (fn: () => void, ms: number) => CancelTimer;
  /** Applied to every `request` that doesn't pass its own `timeoutMs`. */
  defaultTimeoutMs?: number;
};

export type Rpc = {
  request: (
    kind: string,
    payload: unknown,
    options?: RequestOptions,
  ) => Promise<unknown>;
  handle: (
    kind: string,
    fn: (payload: unknown) => unknown | Promise<unknown>,
  ) => void;
  /** In-flight requests awaiting a reply — a diagnostic/leak-detection hook. */
  pendingCount: () => number;
};

export class RpcTimeoutError extends Error {
  constructor(kind: string, ms: number) {
    super(`RPC '${kind}' timed out after ${ms}ms`);
    this.name = "RpcTimeoutError";
  }
}

const REPLY_SUFFIX = ":reply";

/** Best-effort globally-unique id source with no host dependency. */
function defaultIdFactory(): () => string {
  const prefix =
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cancelTimer: CancelTimer | undefined;
};

export function createRpc(transport: Transport, options: RpcOptions = {}): Rpc {
  const pending = new Map<string, Pending>();
  const handlers = new Map<
    string,
    (payload: unknown) => unknown | Promise<unknown>
  >();

  const newId = options.newId ?? defaultIdFactory();
  const { setTimer, defaultTimeoutMs } = options;

  transport.onMessage((envelope) => {
    if (envelope.kind.endsWith(REPLY_SUFFIX)) {
      const entry = pending.get(envelope.id);
      if (!entry) return; // unmatched / late / foreign reply: drop
      pending.delete(envelope.id);
      entry.cancelTimer?.();
      if (envelope.error !== undefined) entry.reject(new Error(envelope.error));
      else entry.resolve(envelope.payload);
      return;
    }

    const handler = handlers.get(envelope.kind);
    if (!handler) return; // not ours — another context may answer
    const replyKind = envelope.kind + REPLY_SUFFIX;
    Promise.resolve()
      .then(() => handler(envelope.payload))
      .then(
        (reply) =>
          transport.send({ id: envelope.id, kind: replyKind, payload: reply }),
        (err: unknown) =>
          transport.send({
            id: envelope.id,
            kind: replyKind,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
  });

  return {
    request(kind, payload, requestOptions) {
      const id = newId();
      return new Promise((resolve, reject) => {
        const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs;
        let cancelTimer: CancelTimer | undefined;
        if (setTimer && timeoutMs !== undefined && timeoutMs > 0) {
          cancelTimer = setTimer(() => {
            if (!pending.delete(id)) return;
            reject(new RpcTimeoutError(kind, timeoutMs));
          }, timeoutMs);
        }
        pending.set(id, { resolve, reject, cancelTimer });
        transport.send({ id, kind, payload });
      });
    },
    handle(kind, fn) {
      handlers.set(kind, fn);
    },
    pendingCount() {
      return pending.size;
    },
  };
}

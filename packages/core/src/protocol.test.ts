import { describe, expect, it } from "vitest";
import {
  createRpc,
  RpcTimeoutError,
  type Envelope,
  type Transport,
} from "./protocol";

/** Drain the microtask queue so RPC handler `.then` chains run before we flush. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/**
 * A shared bus modelling `chrome.runtime.sendMessage`: a `send` is delivered to
 * every connected node EXCEPT the sender. Delivery is manual (`flush`) so tests
 * can force reply interleaving; `order` reorders each node's inbox on flush.
 */
function createBroadcastBus() {
  type Node = { listeners: Array<(e: Envelope) => void>; inbox: Envelope[] };
  const nodes: Node[] = [];

  return {
    connect(): Transport {
      const self: Node = { listeners: [], inbox: [] };
      nodes.push(self);
      return {
        send: (e) => {
          for (const n of nodes) if (n !== self) n.inbox.push(e);
        },
        onMessage: (fn) => self.listeners.push(fn),
      };
    },
    /** One delivery pass; returns whether anything was delivered. */
    flush(order?: (msgs: Envelope[]) => Envelope[]): boolean {
      let delivered = false;
      for (const n of nodes) {
        if (n.inbox.length === 0) continue;
        delivered = true;
        const msgs = order ? order(n.inbox.splice(0)) : n.inbox.splice(0);
        for (const m of msgs) for (const fn of n.listeners) fn(m);
      }
      return delivered;
    },
  };
}

/** Interleave flush + microtask drain until the bus goes quiet. */
async function pump(bus: ReturnType<typeof createBroadcastBus>) {
  for (let i = 0; i < 10; i++) {
    await settle();
    if (!bus.flush()) break;
  }
  await settle();
}

/** Manual timer: fires only when the test says so; tracks outstanding timers. */
function createManualTimer() {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => {
      const myId = ++id;
      timers.set(myId, fn);
      return () => {
        timers.delete(myId);
      };
    },
    fireAll: () => {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
    outstanding: () => timers.size,
  };
}

describe("createRpc — basics", () => {
  it("request resolves to the handler's reply", async () => {
    const bus = createBroadcastBus();
    const client = createRpc(bus.connect());
    const server = createRpc(bus.connect());
    server.handle("echo", (payload) => payload);

    const promise = client.request("echo", "hi");
    await pump(bus);

    await expect(promise).resolves.toBe("hi");
    expect(client.pendingCount()).toBe(0);
  });

  it("drops an unmatched late reply instead of mis-resolving", async () => {
    const bus = createBroadcastBus();
    const clientTransport = bus.connect();
    const client = createRpc(clientTransport);
    const server = createRpc(bus.connect());
    server.handle("echo", (payload) => payload);

    const pending = client.request("echo", "real");
    await settle();
    // Inject a stray reply whose id matches no pending request, ahead of the real one.
    bus.flush((msgs) => [
      { id: "stray-id", kind: "echo:reply", payload: "bogus" },
      ...msgs,
    ]);
    await pump(bus);

    await expect(pending).resolves.toBe("real");
  });
});

describe("createRpc — cross-context id isolation (Codex high finding)", () => {
  it("two clients on a broadcast bus never resolve each other's replies", async () => {
    const bus = createBroadcastBus();
    // Default id factory on purpose: reverting it to a per-instance counter
    // (both clients starting at rpc-0) makes this test cross-resolve → RED.
    const clientA = createRpc(bus.connect());
    const clientB = createRpc(bus.connect());
    const server = createRpc(bus.connect());
    server.handle("echo", (payload) => payload);

    const a = clientA.request("echo", "A");
    const b = clientB.request("echo", "B");

    bus.flush(); // deliver both requests to the server (and cross to the clients, ignored)
    await settle(); // server schedules + sends both replies
    // Deliver replies REVERSED so a colliding-id client would grab the other's reply first.
    bus.flush((msgs) => [...msgs].reverse());
    await settle();

    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
    expect(clientA.pendingCount()).toBe(0);
    expect(clientB.pendingCount()).toBe(0);
  });
});

describe("createRpc — failure paths (Codex medium finding)", () => {
  it("rejects the caller when a handler throws synchronously", async () => {
    const bus = createBroadcastBus();
    const client = createRpc(bus.connect());
    const server = createRpc(bus.connect());
    server.handle("boom", () => {
      throw new Error("kaboom");
    });

    const p = client.request("boom", null);
    await pump(bus);

    await expect(p).rejects.toThrow("kaboom");
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects the caller when an async handler rejects", async () => {
    const bus = createBroadcastBus();
    const client = createRpc(bus.connect());
    const server = createRpc(bus.connect());
    server.handle("boom", async () => {
      throw new Error("async-kaboom");
    });

    const p = client.request("boom", null);
    await pump(bus);

    await expect(p).rejects.toThrow("async-kaboom");
    expect(client.pendingCount()).toBe(0);
  });

  it("times out and cleans up the pending entry when nobody answers", async () => {
    const bus = createBroadcastBus();
    const timer = createManualTimer();
    const client = createRpc(bus.connect(), {
      setTimer: timer.setTimer,
      defaultTimeoutMs: 1_000,
    });
    // No server / no handler registered for this kind.

    const p = client.request("void", "x");
    await pump(bus);
    expect(client.pendingCount()).toBe(1); // still waiting — no leak yet, but hung

    timer.fireAll();

    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(client.pendingCount()).toBe(0); // leak-free after timeout
  });

  it("cancels the timeout once a reply arrives (no dangling timer)", async () => {
    const bus = createBroadcastBus();
    const timer = createManualTimer();
    const client = createRpc(bus.connect(), {
      setTimer: timer.setTimer,
      defaultTimeoutMs: 1_000,
    });
    const server = createRpc(bus.connect());
    server.handle("echo", (payload) => payload);

    const p = client.request("echo", "ok");
    await pump(bus);

    await expect(p).resolves.toBe("ok");
    expect(timer.outstanding()).toBe(0);
    expect(client.pendingCount()).toBe(0);
  });
});

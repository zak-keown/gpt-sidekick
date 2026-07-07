import { describe, expect, it } from "vitest";
import { createRpc, type Envelope, type Rpc, type Transport } from "./protocol";
import { InMemoryTranscriptStore } from "./store";
import { RulesExtractor } from "./extractor";
import {
  fetchOutline,
  fetchRecord,
  fetchRecords,
  pushTranscript,
  registerStoreService,
} from "./service";
import type { TranscriptEvent } from "./model";

/** A transport that feeds a single rpc its own messages — so `request` reaches
 *  the `handle`r on the same instance. `Promise.resolve()` (not queueMicrotask,
 *  which core's DOM-free lib lacks) drains the reply on the microtask queue. */
function loopback(): Transport {
  let listener: ((e: Envelope) => void) | undefined;
  return {
    send: (e) => {
      void Promise.resolve().then(() => listener?.(e));
    },
    onMessage: (l) => {
      listener = l;
    },
  };
}

function serviceRpc(store = new InMemoryTranscriptStore(() => "T")): Rpc {
  let n = 0;
  const rpc = createRpc(loopback(), { newId: () => `id-${n++}` });
  registerStoreService(rpc, store, RulesExtractor);
  return rpc;
}

/** An assistant turn whose fenced code block reliably yields one Code item. */
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

describe("store service over RPC — the SW-owned pipeline", () => {
  it("upserts, indexes, and returns counts consistent with the stored outline", async () => {
    const rpc = serviceRpc();
    const result = await pushTranscript(rpc, [codeEvent("m1", 0)]);

    expect(result.messages).toBe(1);
    expect(result.written).toBe(true);
    expect(result.items).toBeGreaterThanOrEqual(1); // the fenced block became an item
    const outline = await fetchOutline(rpc, "c1");
    expect(outline).toHaveLength(result.items);
  });

  it("serves a single record for source-jump, null when absent", async () => {
    const rpc = serviceRpc();
    await pushTranscript(rpc, [codeEvent("m1", 0)]);

    expect((await fetchRecord(rpc, "c1", "m1"))?.messageId).toBe("m1");
    expect(await fetchRecord(rpc, "c1", "missing")).toBeNull();
  });

  it("returns records in conversation order regardless of push order", async () => {
    const rpc = serviceRpc();
    await pushTranscript(rpc, [codeEvent("m2", 1), codeEvent("m1", 0)]);

    const recs = await fetchRecords(rpc, "c1");
    expect(recs.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });

  it("is idempotent across re-pushes of a grown conversation", async () => {
    const rpc = serviceRpc();
    await pushTranscript(rpc, [codeEvent("m1", 0)]);
    const second = await pushTranscript(rpc, [codeEvent("m1", 0), codeEvent("m2", 1)]);

    expect(second.messages).toBe(2);
    expect((await fetchRecords(rpc, "c1")).map((r) => r.messageId)).toEqual([
      "m1",
      "m2",
    ]);
  });
});

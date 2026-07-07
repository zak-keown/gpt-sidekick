import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DexieTranscriptStore } from "./index";
import type { OutlineItem, Role, TranscriptEvent } from "@gpt-sidekick/core/model";

let dbSeq = 0;
function freshStore(now: () => string = () => "T"): DexieTranscriptStore {
  dbSeq++;
  return new DexieTranscriptStore(`test-db-${dbSeq}`, now);
}

function ev(
  messageId: string,
  text: string,
  turnIndex: number,
  messageIndex = 0,
  role: Role = "assistant",
  conversationId = "c1",
): TranscriptEvent {
  return {
    provider: "chatgpt",
    conversationId,
    messageId,
    role,
    text,
    turnIndex,
    messageIndex,
    anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
  };
}

const item = (id: string): OutlineItem => ({
  id,
  type: "note",
  title: "t",
  summary: "s",
  evidence: [],
});

describe("DexieTranscriptStore — TranscriptStore contract over IndexedDB", () => {
  it("returns records ordered by (turnIndex, messageIndex) regardless of upsert order", async () => {
    const store = freshStore();
    await store.upsertRecords([
      ev("answer", "a", 5, 2),
      ev("b", "two", 1),
      ev("tool", "t", 5, 0, "tool"),
      ev("a", "one", 0),
      ev("reason", "r", 5, 1),
    ]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["a", "b", "tool", "reason", "answer"]);
    expect(recs.map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is idempotent: re-upsert updates in place, ordinal + capturedAt stable", async () => {
    let t = 0;
    const store = freshStore(() => `T${t++}`);
    await store.upsertRecords([ev("a", "one", 0), ev("b", "two", 1)]);
    await store.upsertRecords([ev("a", "one EDITED", 0)]);
    const recs = await store.getRecords("c1");
    expect(recs).toHaveLength(2);
    const a = recs.find((r) => r.messageId === "a");
    expect(a?.text).toBe("one EDITED");
    expect(a?.ordinal).toBe(0);
    expect(a?.capturedAt).toBe("T0");
  });

  it("sorts a turn backfilled after a partial pass into its true place", async () => {
    const store = freshStore();
    await store.upsertRecords([ev("a", "turn0", 0), ev("c", "turn2", 2)]);
    await store.upsertRecords([ev("b", "turn1", 1)]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["a", "b", "c"]);
  });

  it("looks up a single record by id (source-jump)", async () => {
    const store = freshStore();
    await store.upsertRecords([ev("a", "one", 0)]);
    expect((await store.getRecord("c1", "a"))?.text).toBe("one");
    expect(await store.getRecord("c1", "missing")).toBeUndefined();
  });

  it("snapshots records + a revision that bumps on upsert", async () => {
    const store = freshStore();
    const empty = await store.snapshot("c1");
    expect(empty.records).toEqual([]);
    await store.upsertRecords([ev("a", "one", 0)]);
    const snap = await store.snapshot("c1");
    expect(snap.records).toHaveLength(1);
    expect(snap.revision).toBeGreaterThan(empty.revision);
  });

  it("rejects a stale outline write against the current records revision (CAS)", async () => {
    const store = freshStore();
    await store.upsertRecords([ev("m1", "first", 0)]);
    const stale = await store.snapshot("c1");
    await store.upsertRecords([ev("m2", "second", 1)]);
    const fresh = await store.snapshot("c1");

    expect(await store.putOutline("c1", [item("new")], fresh.revision)).toBe(true);
    expect(await store.putOutline("c1", [item("old")], stale.revision)).toBe(false);
    expect((await store.getOutline("c1")).map((i) => i.id)).toEqual(["new"]);
  });

  it("persists across store instances on the same database (the Dexie value)", async () => {
    dbSeq++;
    const name = `persist-db-${dbSeq}`;
    const first = new DexieTranscriptStore(name, () => "T");
    await first.upsertRecords([ev("a", "durable", 0)]);
    await first.putOutline("c1", [item("x")], (await first.snapshot("c1")).revision);

    const second = new DexieTranscriptStore(name, () => "T");
    expect((await second.getRecord("c1", "a"))?.text).toBe("durable");
    expect((await second.getOutline("c1")).map((i) => i.id)).toEqual(["x"]);
  });
});

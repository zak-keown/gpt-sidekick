import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore, hashText } from "./store";
import type { Role, TranscriptEvent } from "./model";

function ev(
  messageId: string,
  text: string,
  turnIndex: number,
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
    anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
  };
}

describe("InMemoryTranscriptStore", () => {
  it("orders records by turnIndex and returns them sorted", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([ev("a", "one", 0), ev("b", "two", 1), ev("c", "three", 2)]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["a", "b", "c"]);
    expect(recs.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  it("sorts a turn backfilled after a partial pass into its true place (Codex high)", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    // Pass 1: turns 0 and 2 captured; turn 1 was unstable (virtualized/partial flow).
    await store.upsertRecords([ev("a", "turn0", 0), ev("c", "turn2", 2)]);
    // Pass 2: turn 1 backfilled — later in capture time, but earlier in the chat.
    await store.upsertRecords([ev("b", "turn1", 1)]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["a", "b", "c"]); // NOT a, c, b
    expect(recs.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  it("keeps multi-node turns (shared turnIndex) in capture order", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    // A tool->reasoning->answer turn: three messages, same turnIndex, captured together.
    await store.upsertRecords([
      ev("tool", "t", 5, "tool"),
      ev("reason", "r", 5),
      ev("answer", "a", 5),
    ]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["tool", "reason", "answer"]);
  });

  it("is idempotent on [conversationId+messageId]: re-upsert updates in place", async () => {
    let t = 0;
    const store = new InMemoryTranscriptStore(() => `T${t++}`);
    await store.upsertRecords([ev("a", "one", 0), ev("b", "two", 1)]);
    await store.upsertRecords([ev("a", "one EDITED", 0)]); // same id, new text

    const recs = await store.getRecords("c1");
    expect(recs).toHaveLength(2); // not 3
    const a = recs.find((r) => r.messageId === "a");
    expect(a?.ordinal).toBe(0); // stable position
    expect(a?.text).toBe("one EDITED"); // content updated
    expect(a?.capturedAt).toBe("T0"); // first-capture time preserved
    expect(a?.textHash).toBe(hashText("one EDITED")); // hash tracks new text
  });

  it("looks up a single record by id (source-jump)", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([ev("a", "one", 0)]);
    expect((await store.getRecord("c1", "a"))?.text).toBe("one");
    expect(await store.getRecord("c1", "missing")).toBeUndefined();
  });

  it("keeps conversations separate", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([
      ev("a", "one", 0, "user", "c1"),
      ev("a", "other", 0, "user", "c2"),
    ]);
    expect((await store.getRecord("c1", "a"))?.text).toBe("one");
    expect((await store.getRecord("c2", "a"))?.text).toBe("other");
  });

  it("persists and returns an outline", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.putOutline("c1", [
      { id: "x", type: "note", title: "t", summary: "s", evidence: [] },
    ]);
    expect(await store.getOutline("c1")).toHaveLength(1);
    expect(await store.getOutline("c2")).toEqual([]);
  });

  it("hashText is deterministic and text-sensitive", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});

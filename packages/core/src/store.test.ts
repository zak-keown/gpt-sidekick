import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore, hashText } from "./store";
import type { Role, TranscriptEvent } from "./model";

function ev(
  messageId: string,
  text: string,
  role: Role = "assistant",
  conversationId = "c1",
): TranscriptEvent {
  return {
    provider: "chatgpt",
    conversationId,
    messageId,
    role,
    text,
    anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
  };
}

describe("InMemoryTranscriptStore", () => {
  it("assigns ordinals in insertion order and returns records sorted", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([ev("a", "one"), ev("b", "two"), ev("c", "three")]);
    const recs = await store.getRecords("c1");
    expect(recs.map((r) => r.messageId)).toEqual(["a", "b", "c"]);
    expect(recs.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  it("is idempotent on [conversationId+messageId]: re-upsert updates in place", async () => {
    let t = 0;
    const store = new InMemoryTranscriptStore(() => `T${t++}`);
    await store.upsertRecords([ev("a", "one"), ev("b", "two")]);
    await store.upsertRecords([ev("a", "one EDITED")]); // same id, new text

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
    await store.upsertRecords([ev("a", "one")]);
    expect((await store.getRecord("c1", "a"))?.text).toBe("one");
    expect(await store.getRecord("c1", "missing")).toBeUndefined();
  });

  it("keeps conversations separate", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([ev("a", "one", "user", "c1"), ev("a", "other", "user", "c2")]);
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

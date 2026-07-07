import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "./store";
import { indexConversation } from "./pipeline";
import { RulesExtractor } from "./extractor";
import type { Role, TranscriptEvent } from "./model";

function ev(messageId: string, text: string, role: Role = "assistant"): TranscriptEvent {
  return {
    provider: "chatgpt",
    conversationId: "c1",
    messageId,
    role,
    text,
    anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
  };
}

describe("indexConversation — records → extract → check → persist", () => {
  it("indexes captured events into a validated, persisted outline", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    await store.upsertRecords([
      ev("m1", "Should we cache responses?", "user"),
      ev("m2", "We'll go with Postgres.\n```\nSELECT 1;\n```", "assistant"),
    ]);

    const { items, droppedNoEvidence } = await indexConversation(
      store,
      "c1",
      RulesExtractor,
    );

    expect(droppedNoEvidence).toBe(0);
    expect(items.length).toBeGreaterThan(0);
    expect(await store.getOutline("c1")).toEqual(items);

    // Every persisted item's evidence resolves to a real record, exact at offsets.
    for (const item of items) {
      const ref = item.evidence[0];
      expect(ref).toBeTruthy();
      const record = await store.getRecord("c1", ref!.messageId);
      expect(record).toBeTruthy();
      expect(record!.text.slice(ref!.offsetStart, ref!.offsetEnd)).toBe(ref!.quote);
    }
  });

  it("re-indexing is stable (idempotent upsert + deterministic ids)", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    const events = [ev("m1", "Let's add retries.", "assistant")];
    await store.upsertRecords(events);
    const first = await indexConversation(store, "c1", RulesExtractor);

    await store.upsertRecords(events); // re-capture same content
    const second = await indexConversation(store, "c1", RulesExtractor);

    expect(second.items).toEqual(first.items); // same ids, same evidence
  });
});

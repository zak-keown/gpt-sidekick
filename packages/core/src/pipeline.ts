import { validateOutline } from "./evidence";
import type { Extractor } from "./extractor";
import type { OutlineItem } from "./model";
import type { TranscriptStore } from "./store";

export type IndexResult = {
  items: OutlineItem[];
  droppedNoEvidence: number;
  /** False if a newer capture pass already wrote a fresher outline (this run was stale). */
  written: boolean;
};

/**
 * The trust loop, wired end to end (SPEC §6.4): read a conversation's records,
 * run the (rules or, later, neural) extractor, enforce the Evidence Invariant
 * once, and persist the surviving outline. Idempotent — re-running on unchanged
 * records yields the same outline (deterministic ids), so it is safe to re-index
 * a grown conversation.
 */
export async function indexConversation(
  store: TranscriptStore,
  conversationId: string,
  extractor: Extractor,
): Promise<IndexResult> {
  const { records, revision } = await store.snapshot(conversationId);
  const candidates = extractor.extract(records);
  const { items, droppedNoEvidence } = validateOutline(candidates, records);
  const written = await store.putOutline(conversationId, items, revision);
  return { items, droppedNoEvidence, written };
}

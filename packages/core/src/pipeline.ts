import { validateOutline } from "./evidence";
import type { Extractor } from "./extractor";
import type { OutlineItem } from "./model";
import type { TranscriptStore } from "./store";

export type IndexResult = {
  items: OutlineItem[];
  droppedNoEvidence: number;
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
  const records = await store.getRecords(conversationId);
  const candidates = extractor.extract(records);
  const { items, droppedNoEvidence } = validateOutline(candidates, records);
  await store.putOutline(conversationId, items);
  return { items, droppedNoEvidence };
}

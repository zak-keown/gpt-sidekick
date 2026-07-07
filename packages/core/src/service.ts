/**
 * The store service — the RPC contract between the service worker (which owns
 * the store) and the contexts that feed or read it (SPEC §7, §12.3). Pure and
 * host-free: it binds RPC kinds to `TranscriptStore` + `Extractor` operations,
 * so the same handlers work over any transport (the routed SW RPC in the
 * extension; a loopback in tests).
 *
 * The wire kinds live here as the single shared contract; both the SW handlers
 * (`registerStoreService`) and the typed client helpers below reference them, so
 * a rename can't drift the two sides apart.
 */

import type { Rpc } from "./protocol";
import type { Extractor } from "./extractor";
import type { TranscriptStore } from "./store";
import type { OutlineItem, TranscriptEvent, TranscriptRecord } from "./model";
import { indexConversation } from "./pipeline";

export const SERVICE_KINDS = {
  push: "transcript/push",
  outline: "transcript/outline",
  records: "transcript/records",
  record: "transcript/record",
} as const;

/** Counts surfaced back to the pusher (SPEC §12.3 `meta.counts`). */
export type PushResult = {
  messages: number;
  items: number;
  droppedNoEvidence: number;
  /** False if a fresher pass already wrote a newer outline (this push was stale). */
  written: boolean;
};

type PushPayload = { events: TranscriptEvent[] };
type ConversationPayload = { conversationId: string };
type RecordPayload = { conversationId: string; messageId: string };

/**
 * Register the store handlers on an `Rpc`. The SW calls this once with the
 * Dexie-backed store; tests call it with the in-memory store. A push upserts the
 * events, then re-indexes each affected conversation through the trust pipeline
 * (extract → Evidence Invariant → persist), returning aggregate counts.
 */
export function registerStoreService(
  rpc: Rpc,
  store: TranscriptStore,
  extractor: Extractor,
): void {
  rpc.handle(SERVICE_KINDS.push, async (payload) => {
    const events = (payload as PushPayload).events;
    await store.upsertRecords(events);

    const conversationIds = [...new Set(events.map((e) => e.conversationId))];
    let items = 0;
    let droppedNoEvidence = 0;
    let written = true;
    for (const conversationId of conversationIds) {
      const result = await indexConversation(store, conversationId, extractor);
      items += result.items.length;
      droppedNoEvidence += result.droppedNoEvidence;
      written = written && result.written;
    }
    return {
      messages: events.length,
      items,
      droppedNoEvidence,
      written,
    } satisfies PushResult;
  });

  rpc.handle(SERVICE_KINDS.outline, (payload) =>
    store.getOutline((payload as ConversationPayload).conversationId),
  );

  rpc.handle(SERVICE_KINDS.records, (payload) =>
    store.getRecords((payload as ConversationPayload).conversationId),
  );

  rpc.handle(SERVICE_KINDS.record, async (payload) => {
    const { conversationId, messageId } = payload as RecordPayload;
    // Normalise `undefined` (a missing record) to `null` so it survives the
    // JSON round-trip of a real transport as a present-but-empty reply.
    return (await store.getRecord(conversationId, messageId)) ?? null;
  });
}

// --- Typed client helpers (the caller's side of the same contract) ---

export function pushTranscript(
  rpc: Rpc,
  events: TranscriptEvent[],
): Promise<PushResult> {
  return rpc.request(SERVICE_KINDS.push, {
    events,
  } satisfies PushPayload) as Promise<PushResult>;
}

export function fetchOutline(
  rpc: Rpc,
  conversationId: string,
): Promise<OutlineItem[]> {
  return rpc.request(SERVICE_KINDS.outline, {
    conversationId,
  } satisfies ConversationPayload) as Promise<OutlineItem[]>;
}

export function fetchRecords(
  rpc: Rpc,
  conversationId: string,
): Promise<TranscriptRecord[]> {
  return rpc.request(SERVICE_KINDS.records, {
    conversationId,
  } satisfies ConversationPayload) as Promise<TranscriptRecord[]>;
}

export function fetchRecord(
  rpc: Rpc,
  conversationId: string,
  messageId: string,
): Promise<TranscriptRecord | null> {
  return rpc.request(SERVICE_KINDS.record, {
    conversationId,
    messageId,
  } satisfies RecordPayload) as Promise<TranscriptRecord | null>;
}

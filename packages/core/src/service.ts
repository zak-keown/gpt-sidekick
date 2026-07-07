/**
 * The store service — the RPC contract between the service worker (which owns
 * the store) and the contexts that feed or read it (SPEC §7, §12.3). Pure and
 * host-free: it binds RPC kinds to `TranscriptStore` + `Extractor` operations,
 * so the same handlers work over any host (the routed SW dispatcher in the
 * extension; a fake host in tests).
 *
 * The SW must know WHICH tab a message came from — to notify that tab's panel of
 * a fresh outline (a live outline is a push, not a poll), and to map
 * `tab → conversationId` so a panel can fetch the right conversation. Chrome
 * attests that source, but core's `Rpc.handle` hides it, so the service runs on
 * a small `StoreServiceHost` whose handlers receive the attested `source` and
 * which can `push` to a target. Reads ignore `source`; the push handler uses it.
 *
 * Wire kinds live here as the single shared contract so the SW handlers and the
 * typed client helpers can't drift apart.
 */

import type { Rpc } from "./protocol";
import type { Address } from "./router";
import type { Extractor } from "./extractor";
import type { TranscriptStore } from "./store";
import type { OutlineItem, TranscriptEvent, TranscriptRecord } from "./model";
import { indexConversation } from "./pipeline";

export const SERVICE_KINDS = {
  push: "transcript/push",
  outline: "transcript/outline",
  records: "transcript/records",
  record: "transcript/record",
  /** SW→panel: "the outline for this conversation changed, refetch". */
  changed: "transcript/changed",
  /** panel→SW: "which conversation is my tab showing?" */
  conversation: "transcript/conversation",
} as const;

/** Counts surfaced back to the pusher (SPEC §12.3 `meta.counts`). */
export type PushResult = {
  messages: number;
  items: number;
  droppedNoEvidence: number;
  /** False if a fresher pass already wrote a newer outline (this push was stale). */
  written: boolean;
};

/**
 * The SW-side host the service runs on: source-aware request handlers plus a
 * one-way push to a routed target. The chrome adapter implements this over the
 * §13 router; tests fake it. (This is intentionally NOT `Rpc` — handlers here
 * receive the attested `source`.)
 */
export interface StoreServiceHost {
  handle(
    kind: string,
    fn: (payload: unknown, source: Address) => unknown | Promise<unknown>,
  ): void;
  push(target: Address, kind: string, payload: unknown): void;
}

type PushPayload = { events: TranscriptEvent[] };
type ConversationPayload = { conversationId: string };
type RecordPayload = { conversationId: string; messageId: string };

/**
 * Register the store handlers on the SW host. A push upserts the events, then
 * re-indexes each affected conversation through the trust pipeline (extract →
 * Evidence Invariant → persist). When the push came from a content script, it
 * also (a) records `tab → conversationId` so that tab's panel can fetch the
 * right conversation, and (b) notifies that panel to refetch — a live outline.
 */
export function registerStoreService(
  host: StoreServiceHost,
  store: TranscriptStore,
  extractor: Extractor,
): void {
  // Ephemeral SW state: which conversation each tab is currently showing.
  // Rebuilt from pushes when the SW wakes; the durable data lives in the store.
  const tabConversation = new Map<number, string>();

  host.handle(SERVICE_KINDS.push, async (payload, source) => {
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

    // Only a Chrome-attested content script pins a tab's conversation and gets
    // its panel notified. (A non-content source has no tab to route back to.)
    if (source.context === "content") {
      for (const conversationId of conversationIds) {
        tabConversation.set(source.tabId, conversationId);
        host.push({ context: "panel", tabId: source.tabId }, SERVICE_KINDS.changed, {
          conversationId,
        } satisfies ConversationPayload);
      }
    }

    return { messages: events.length, items, droppedNoEvidence, written } satisfies PushResult;
  });

  host.handle(SERVICE_KINDS.conversation, (_payload, source) =>
    source.context === "panel" ? (tabConversation.get(source.tabId) ?? null) : null,
  );

  host.handle(SERVICE_KINDS.outline, (payload) =>
    store.getOutline((payload as ConversationPayload).conversationId),
  );

  host.handle(SERVICE_KINDS.records, (payload) =>
    store.getRecords((payload as ConversationPayload).conversationId),
  );

  host.handle(SERVICE_KINDS.record, async (payload) => {
    const { conversationId, messageId } = payload as RecordPayload;
    // Normalise `undefined` to `null` so a missing record survives the JSON
    // round-trip of a real transport as a present-but-empty reply.
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

/** Ask the SW which conversation this panel's tab is showing (null if unknown yet). */
export function fetchConversationId(rpc: Rpc): Promise<string | null> {
  return rpc.request(SERVICE_KINDS.conversation, {}) as Promise<string | null>;
}

/**
 * Subscribe to "outline changed" pushes from the SW. Call this BEFORE
 * `fetchConversationId` so a change that arrives during startup isn't missed;
 * treat a null conversation id as "wait for the first notify" (a static
 * conversation with a cold SW registry only becomes known once it next pushes).
 */
export function onOutlineChanged(
  rpc: Rpc,
  handler: (conversationId: string) => void,
): void {
  rpc.handle(SERVICE_KINDS.changed, (payload) => {
    handler((payload as ConversationPayload).conversationId);
  });
}

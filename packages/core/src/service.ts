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
  /** panel→SW, then SW→content: run a bounded scroll-and-hydrate pass. */
  reindex: "transcript/reindex",
  reindexRequested: "transcript/reindex-requested",
  /** Content-owned capture state, relayed and readable by its tab's panel. */
  indexStateReport: "transcript/index-state-report",
  indexState: "transcript/index-state",
  indexStateChanged: "transcript/index-state-changed",
  /** panel→SW→content source relocation, with an async result back to panel. */
  jump: "transcript/jump",
  jumpRequested: "transcript/jump-requested",
  jumpResultReport: "transcript/jump-result-report",
  jumpResult: "transcript/jump-result",
} as const;

export type IndexCounts = {
  messages: number;
  items: number;
  droppedNoEvidence: number;
  unstable: number;
};

type CaptureCounts = {
  captured: number;
  expected: number;
  unstable: number;
};

export type IndexingState =
  | { kind: "idle" }
  | ({ kind: "capturing"; processed: number } & CaptureCounts)
  | ({ kind: "indexing" } & CaptureCounts)
  | ({ kind: "ready" } & IndexCounts)
  | ({ kind: "partial"; captured: number; expected: number } & IndexCounts)
  | { kind: "failed"; reason: string };

export type JumpRequestResult =
  | { status: "relocating"; requestId: string }
  | { status: "not-found" };
export type JumpResult = {
  requestId: string;
  status: "found" | "not-found";
};

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
type StatePayload = { state: IndexingState; conversationId?: string };
type JumpRequestedPayload = { requestId: string; messageId: string; turnId?: string };

export type StoreServiceOptions = { newId?: () => string };

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
  options: StoreServiceOptions = {},
): void {
  // Ephemeral SW state: which conversation each tab is currently showing.
  // Rebuilt from pushes when the SW wakes; the durable data lives in the store.
  const tabConversation = new Map<number, string>();
  const tabIndexState = new Map<number, IndexingState>();
  const pendingJumps = new Map<string, number>();
  let nextJumpId = 1;
  const newId = options.newId ?? (() => `jump-${nextJumpId++}`);

  host.handle(SERVICE_KINDS.push, async (payload, source) => {
    const events = (payload as PushPayload).events;
    await store.upsertRecords(events);

    const conversationIds = [...new Set(events.map((e) => e.conversationId))];
    let messages = 0;
    let items = 0;
    let droppedNoEvidence = 0;
    let written = true;
    for (const conversationId of conversationIds) {
      const result = await indexConversation(store, conversationId, extractor);
      items += result.items.length;
      droppedNoEvidence += result.droppedNoEvidence;
      written = written && result.written;
      messages += (await store.getRecords(conversationId)).length;
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

    return { messages, items, droppedNoEvidence, written } satisfies PushResult;
  });

  // Read authorization — the §13 tenant boundary for READS. Targeted delivery
  // stops a client from *addressing* another tab's panel, but every context may
  // address the SW, so the read handlers themselves must scope by the attested
  // source: a panel may read ONLY the conversation its own tab is showing.
  // Without this, a panel that knows another tab's conversationId could fetch its
  // transcript. Content scripts do not read at all. (Codex, 2026-07-07.)
  const canRead = (source: Address, conversationId: string): boolean =>
    source.context === "panel" &&
    tabConversation.get(source.tabId) === conversationId;

  host.handle(SERVICE_KINDS.conversation, (_payload, source) =>
    source.context === "panel" ? (tabConversation.get(source.tabId) ?? null) : null,
  );

  host.handle(SERVICE_KINDS.outline, (payload, source) => {
    const { conversationId } = payload as ConversationPayload;
    return canRead(source, conversationId) ? store.getOutline(conversationId) : [];
  });

  host.handle(SERVICE_KINDS.records, (payload, source) => {
    const { conversationId } = payload as ConversationPayload;
    return canRead(source, conversationId) ? store.getRecords(conversationId) : [];
  });

  host.handle(SERVICE_KINDS.record, async (payload, source) => {
    const { conversationId, messageId } = payload as RecordPayload;
    if (!canRead(source, conversationId)) return null;
    // Normalise `undefined` to `null` so a missing record survives the JSON
    // round-trip of a real transport as a present-but-empty reply.
    return (await store.getRecord(conversationId, messageId)) ?? null;
  });

  host.handle(SERVICE_KINDS.reindex, (_payload, source) => {
    if (source.context !== "panel" || !tabConversation.has(source.tabId)) {
      return { accepted: false };
    }
    host.push({ context: "content", tabId: source.tabId }, SERVICE_KINDS.reindexRequested, {});
    return { accepted: true };
  });

  host.handle(SERVICE_KINDS.indexStateReport, (payload, source) => {
    if (source.context !== "content") return { accepted: false };
    const { state, conversationId } = payload as StatePayload;
    if (conversationId) tabConversation.set(source.tabId, conversationId);
    tabIndexState.set(source.tabId, state);
    host.push(
      { context: "panel", tabId: source.tabId },
      SERVICE_KINDS.indexStateChanged,
      { state } satisfies StatePayload,
    );
    return { accepted: true };
  });

  host.handle(SERVICE_KINDS.indexState, (_payload, source) =>
    source.context === "panel"
      ? (tabIndexState.get(source.tabId) ?? ({ kind: "idle" } satisfies IndexingState))
      : ({ kind: "idle" } satisfies IndexingState),
  );

  host.handle(SERVICE_KINDS.jump, async (payload, source) => {
    if (source.context !== "panel") return { status: "not-found" };
    const { conversationId, messageId } = payload as RecordPayload;
    if (!canRead(source, conversationId)) return { status: "not-found" };
    const record = await store.getRecord(conversationId, messageId);
    if (!record) return { status: "not-found" };
    const requestId = newId();
    pendingJumps.set(requestId, source.tabId);
    host.push(
      { context: "content", tabId: source.tabId },
      SERVICE_KINDS.jumpRequested,
      {
        requestId,
        messageId,
        turnId: record.turnId,
      } satisfies JumpRequestedPayload,
    );
    return { status: "relocating", requestId } satisfies JumpRequestResult;
  });

  host.handle(SERVICE_KINDS.jumpResultReport, (payload, source) => {
    if (source.context !== "content") return { accepted: false };
    const result = payload as JumpResult;
    if (pendingJumps.get(result.requestId) !== source.tabId) return { accepted: false };
    pendingJumps.delete(result.requestId);
    host.push(
      { context: "panel", tabId: source.tabId },
      SERVICE_KINDS.jumpResult,
      result,
    );
    return { accepted: true };
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

export function requestReindex(rpc: Rpc): Promise<{ accepted: boolean }> {
  return rpc.request(SERVICE_KINDS.reindex, {}) as Promise<{ accepted: boolean }>;
}

export function onReindexRequested(rpc: Rpc, handler: () => void | Promise<void>): void {
  rpc.handle(SERVICE_KINDS.reindexRequested, handler);
}

export function reportIndexState(
  rpc: Rpc,
  state: IndexingState,
  conversationId?: string,
): Promise<{ accepted: boolean }> {
  return rpc.request(SERVICE_KINDS.indexStateReport, {
    state,
    conversationId,
  } satisfies StatePayload) as Promise<{ accepted: boolean }>;
}

export function fetchIndexState(rpc: Rpc): Promise<IndexingState> {
  return rpc.request(SERVICE_KINDS.indexState, {}) as Promise<IndexingState>;
}

export function onIndexStateChanged(rpc: Rpc, handler: (state: IndexingState) => void): void {
  rpc.handle(SERVICE_KINDS.indexStateChanged, (payload) => {
    handler((payload as StatePayload).state);
  });
}

export function requestSourceJump(
  rpc: Rpc,
  conversationId: string,
  messageId: string,
): Promise<JumpRequestResult> {
  return rpc.request(SERVICE_KINDS.jump, {
    conversationId,
    messageId,
  } satisfies RecordPayload) as Promise<JumpRequestResult>;
}

export function onJumpRequested(
  rpc: Rpc,
  handler: (request: JumpRequestedPayload) => void | Promise<void>,
): void {
  rpc.handle(SERVICE_KINDS.jumpRequested, (payload) =>
    handler(payload as JumpRequestedPayload),
  );
}

export function reportJumpResult(rpc: Rpc, result: JumpResult): Promise<{ accepted: boolean }> {
  return rpc.request(SERVICE_KINDS.jumpResultReport, result) as Promise<{
    accepted: boolean;
  }>;
}

export function onJumpResult(rpc: Rpc, handler: (result: JumpResult) => void): void {
  rpc.handle(SERVICE_KINDS.jumpResult, (payload) => handler(payload as JumpResult));
}

/**
 * The core data model (SPEC §4) — provider-agnostic and DOM-free. Provider
 * adapters emit events structurally assignable to `TranscriptEvent` (their
 * `provider` is a literal like "chatgpt", assignable to `string`); the store
 * adds ordinal/hash to form a `TranscriptRecord`; the extractor proposes
 * `OutlineCandidate`s that the `EvidenceChecker` validates into `OutlineItem`s.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export type TranscriptEvent = {
  provider: string;
  conversationId: string;
  messageId: string;
  role: Role;
  text: string; // canonical text — the substring space the Evidence Invariant checks
  /**
   * Stable conversation position from the provider's skeleton (for ChatGPT, the
   * `data-turn-id` index — known up front, identical across capture passes).
   * The store orders by this, NOT by insertion order, so a turn backfilled on a
   * later pass (after an unstable pass) still sorts into its true place.
   * Messages sharing a turn share a turnIndex; `messageIndex` orders them.
   */
  turnIndex: number;
  /**
   * Stable position of this message WITHIN its turn (DOM order for ChatGPT).
   * Primary tiebreak under a shared turnIndex, so a multi-node sibling
   * backfilled on a later pass still sorts into its true within-turn place
   * rather than after whatever was captured first.
   */
  messageIndex: number;
  createdAt?: string;
  turnId?: string;
  anchor: { kind: "dom" | "file" | "transcript"; locator: string };
};

export type TranscriptRecord = TranscriptEvent & {
  ordinal: number; // conversation order, assigned by the store on upsert
  capturedAt: string;
  textHash: string; // hash of canonical text — drift detection + cross-provider reuse
};

export type OutlineType =
  | "decision"
  | "action"
  | "question"
  | "artifact"
  | "code"
  | "correction"
  | "note";

export type Evidence = {
  messageId: string;
  quote: string; // MUST equal record.text.slice(offsetStart, offsetEnd)
  offsetStart: number;
  offsetEnd: number;
};

export type OutlineCandidate = {
  type: OutlineType;
  title: string; // extractive substring — no rewriting (§6.3)
  summary: string; // extractive substring
  evidence: Evidence[];
};

export type OutlineItem = OutlineCandidate & {
  id: string;
  createdAt?: string;
};

/**
 * Capture data model for the ChatGPT provider (SPEC §4/§5). `TranscriptEvent`
 * is the normalized event the adapter emits; the M2 store adds ordinal/hash to
 * form a `TranscriptRecord`.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export type TranscriptEvent = {
  provider: "chatgpt";
  conversationId: string;
  messageId: string; // ChatGPT data-message-id (server UUID) — the durable key
  role: Role;
  text: string; // canonical text (§5.3): prose normalized, code verbatim
  createdAt?: string;
  turnId: string; // owning data-turn-id — persistent source-jump anchor (§5.4)
  anchor: { kind: "dom"; locator: string };
};

/** Honest per-pass capture outcome — never silent-empty (§5.2 steps 5–6). */
export type CaptureState =
  | { kind: "complete" }
  | { kind: "partial"; captured: number; expected: number; unstable: string[] }
  | { kind: "failed"; reason: "no-messages-matched" | "no-conversation-id" };

export type CaptureResult = { events: TranscriptEvent[]; state: CaptureState };

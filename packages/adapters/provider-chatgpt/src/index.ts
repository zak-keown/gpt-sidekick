/**
 * ChatGPT provider adapter — public surface.
 *
 * M1: `capture()` turns a (possibly virtualized) ChatGPT DOM into
 * `TranscriptEvent[]` keyed on the durable `data-message-id`, driving a scroll
 * pass over the persistent `data-turn-id` skeleton via an injected `hydrateTurn`.
 * The live content-script hydrator + targeted routing land in M1b (SPEC §13).
 */
export { capture } from "./capture";
export { anchors, AS_OF } from "./anchors";
export { canonicalizeNode } from "./canonicalize";
export type {
  CaptureResult,
  CaptureState,
  Role,
  TranscriptEvent,
} from "./types";

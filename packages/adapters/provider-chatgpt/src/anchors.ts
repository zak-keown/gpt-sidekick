/**
 * ChatGPT DOM anchors — resolve by DURABLE ATTRIBUTE, never by hashed class
 * (SPEC §5.1; expect churn — companion §4.1). Kept in ONE file so a selector
 * break is a one-line fix pointed at the validating fixture.
 *
 * Validated against:
 *   - test/fixtures/synthetic-2026-07.html (structure; committed),
 *   - fixtures.local/chatgpt/*.html (real captures; local-only, git-ignored).
 */
export const AS_OF = "2026-07";

export const anchors = {
  /** Persistent per-turn skeleton wrapper — survives virtualization. Ordering + scroll target. */
  turn: "[data-turn-id]",
  turnIdAttr: "data-turn-id",
  /** Message identity node — present only while the turn is hydrated. The durable key. */
  message: "[data-message-id]",
  messageIdAttr: "data-message-id",
  roleAttr: "data-message-author-role",
  /** Content root within a message node (avoids capturing chrome/buttons). */
  content: "[data-message-content]",
} as const;

import { anchors } from "./anchors";
import { canonicalizeNode } from "./canonicalize";
import type { CaptureResult, CaptureState, Role, TranscriptEvent } from "./types";

const ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "tool",
]);

function normalizeRole(raw: string | null): Role {
  return raw && ROLES.has(raw) ? (raw as Role) : "assistant";
}

function conversationIdFromUrl(url: string): string | null {
  return url.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
}

/**
 * A turn is hydrated when it holds a `[data-message-id]` node with **non-empty
 * canonical text** — presence alone is not enough (SPEC §5.2 step 2). The live
 * virtualizer can mount a node a beat before its text paints; a presence-only
 * signal would capture empty text. Shared by `capture` (skip condition) and the
 * live hydrator (resolve condition) so both agree on "ready".
 */
export function isHydrated(turn: Element): boolean {
  for (const node of turn.querySelectorAll(anchors.message)) {
    const contentRoot = node.querySelector(anchors.content) ?? node;
    if (canonicalizeNode(contentRoot as Element).length > 0) return true;
  }
  return false;
}

/**
 * Scroll-and-accumulate capture (SPEC §5.2). Walks the persistent `data-turn-id`
 * skeleton (its length N is the true conversation length, known up front); for
 * each turn, hydrates it if empty, then emits one `TranscriptEvent` per
 * `data-message-id` node (multi-node turns split; tool→reasoning→answer are
 * distinct identities). Idempotent within the pass (dedup by `messageId`), and
 * honest about incompleteness — a turn that won't hydrate is counted `unstable`,
 * never silently dropped.
 *
 * `hydrateTurn` is injected (not defaulted): the live content script scrolls +
 * awaits rehydration; tests supply an active fake. The DOM never holds the whole
 * chat at once, but the returned events accumulate it.
 */
export async function capture(opts: {
  root: ParentNode;
  url: string;
  hydrateTurn: (turn: Element) => Promise<void>;
}): Promise<CaptureResult> {
  const { root, url, hydrateTurn } = opts;

  // Conversation identity is the durable key ([conversationId+messageId]); a
  // bad/absent id would co-mingle distinct chats. Fail loudly, never bucket
  // into a shared "unknown" (Codex).
  const conversationId = conversationIdFromUrl(url);
  if (conversationId === null) {
    return { events: [], state: { kind: "failed", reason: "no-conversation-id" } };
  }

  const turns = [...root.querySelectorAll(anchors.turn)];
  if (turns.length === 0) {
    return { events: [], state: { kind: "failed", reason: "no-messages-matched" } };
  }

  const events: TranscriptEvent[] = [];
  const seen = new Set<string>();
  const unstable: string[] = [];
  let capturedTurns = 0;

  for (const [turnIndex, turn] of turns.entries()) {
    if (!isHydrated(turn)) {
      await hydrateTurn(turn);
    }

    const turnId = turn.getAttribute(anchors.turnIdAttr) ?? "";

    // Compute canonical text per node BEFORE counting/emitting. A turn is
    // reported `complete` only when EVERY present message node is "clean" — its
    // content-root anchor matched AND its text is non-empty. Painted siblings
    // are still emitted (non-dropping: never drop a real answer because a tool
    // node is empty), but a turn with an empty/unpainted node, a still-partial
    // multi-node paint, or a missing content-root anchor is flagged `unstable`
    // — never silently reported complete with partial or chrome-polluted text.
    let messageCount = 0;
    let cleanCount = 0;
    for (const [messageIndex, node] of [
      ...turn.querySelectorAll(anchors.message),
    ].entries()) {
      const messageId = node.getAttribute(anchors.messageIdAttr) ?? "";
      if (!messageId) continue;
      messageCount++;

      // Fail CLOSED on a missing content-root anchor: canonicalizing the whole
      // node would pull in chrome/buttons, and an emitted polluted event could
      // feed extraction/storage and let the Evidence Invariant pass against
      // garbage. Emit nothing for it; the turn is flagged unstable below. If the
      // anchor has rotted, the whole pass goes unstable + empty — a loud
      // fix-the-selector signal, not silent pollution (Codex).
      const contentRoot = node.querySelector(anchors.content);
      if (!contentRoot) continue;
      const text = canonicalizeNode(contentRoot as Element);
      if (text.length === 0) continue; // empty shell — not evidence
      cleanCount++;

      if (seen.has(messageId)) continue; // dedup overlapping windows
      seen.add(messageId);
      events.push({
        provider: "chatgpt",
        conversationId,
        messageId,
        role: normalizeRole(node.getAttribute(anchors.roleAttr)),
        text,
        turnIndex, // skeleton position — stable across passes, for backfill-safe ordering
        messageIndex, // DOM position within the turn — stable within-turn order
        turnId,
        anchor: { kind: "dom", locator: `[${anchors.messageIdAttr}="${messageId}"]` },
      });
    }

    if (messageCount > 0 && cleanCount === messageCount) capturedTurns++;
    else unstable.push(turnId); // partial paint / missing content root / no nodes
  }

  const expected = turns.length;
  const state: CaptureState =
    capturedTurns < expected
      ? { kind: "partial", captured: capturedTurns, expected, unstable }
      : { kind: "complete" };
  return { events, state };
}

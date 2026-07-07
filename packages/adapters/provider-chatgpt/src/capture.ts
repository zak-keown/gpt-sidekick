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

function conversationIdFromUrl(url: string): string {
  return url.match(/\/c\/([^/?#]+)/)?.[1] ?? "unknown";
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

  const turns = [...root.querySelectorAll(anchors.turn)];
  if (turns.length === 0) {
    return { events: [], state: { kind: "failed", reason: "no-messages-matched" } };
  }

  const conversationId = conversationIdFromUrl(url);
  const events: TranscriptEvent[] = [];
  const seen = new Set<string>();
  const unstable: string[] = [];
  let capturedTurns = 0;

  for (const turn of turns) {
    if (!isHydrated(turn)) {
      await hydrateTurn(turn);
    }

    const turnId = turn.getAttribute(anchors.turnIdAttr) ?? "";

    // Compute canonical text per node BEFORE counting/emitting. Empty shells
    // (a node mounted but not yet painted, or the hydrator gave up on timeout)
    // are never emitted as text:"" — that would be false evidence. A painted
    // sibling in a multi-node turn still survives: we skip the empty node, not
    // the turn (dropping a real answer because a tool node is empty would be a
    // worse, silent failure). A turn with zero non-empty messages is unstable.
    let turnHasContent = false;
    for (const node of turn.querySelectorAll(anchors.message)) {
      const messageId = node.getAttribute(anchors.messageIdAttr) ?? "";
      if (!messageId) continue;
      const contentRoot = node.querySelector(anchors.content) ?? node;
      const text = canonicalizeNode(contentRoot as Element);
      if (text.length === 0) continue; // empty shell — not evidence
      turnHasContent = true;
      if (seen.has(messageId)) continue; // dedup overlapping windows
      seen.add(messageId);
      events.push({
        provider: "chatgpt",
        conversationId,
        messageId,
        role: normalizeRole(node.getAttribute(anchors.roleAttr)),
        text,
        turnId,
        anchor: { kind: "dom", locator: `[${anchors.messageIdAttr}="${messageId}"]` },
      });
    }

    if (turnHasContent) capturedTurns++;
    else unstable.push(turnId); // no non-empty message — surfaced, never silent
  }

  const expected = turns.length;
  const state: CaptureState =
    capturedTurns < expected
      ? { kind: "partial", captured: capturedTurns, expected, unstable }
      : { kind: "complete" };
  return { events, state };
}

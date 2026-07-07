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
    if (!turn.querySelector(anchors.message)) {
      await hydrateTurn(turn);
    }

    const messageNodes = [...turn.querySelectorAll(anchors.message)];
    const turnId = turn.getAttribute(anchors.turnIdAttr) ?? "";
    if (messageNodes.length === 0) {
      unstable.push(turnId); // hydration failed — no durable source, but not silent
      continue;
    }
    capturedTurns++;

    for (const node of messageNodes) {
      const messageId = node.getAttribute(anchors.messageIdAttr);
      if (!messageId || seen.has(messageId)) continue; // dedup overlapping windows
      seen.add(messageId);
      const contentRoot = node.querySelector(anchors.content) ?? node;
      events.push({
        provider: "chatgpt",
        conversationId,
        messageId,
        role: normalizeRole(node.getAttribute(anchors.roleAttr)),
        text: canonicalizeNode(contentRoot as Element),
        turnId,
        anchor: { kind: "dom", locator: `[${anchors.messageIdAttr}="${messageId}"]` },
      });
    }
  }

  const expected = turns.length;
  const state: CaptureState =
    capturedTurns < expected
      ? { kind: "partial", captured: capturedTurns, expected, unstable }
      : { kind: "complete" };
  return { events, state };
}

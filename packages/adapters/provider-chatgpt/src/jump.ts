import { anchors } from "./anchors";

export type JumpResult = { status: "found" | "not-found" };

type HighlightEntry = {
  timer: ReturnType<typeof setTimeout>;
  attribute: string | null;
  outline: string;
  outlineOffset: string;
  transition: string;
};

const activeHighlights = new WeakMap<HTMLElement, HighlightEntry>();

function byAttribute(
  root: ParentNode,
  selector: string,
  attribute: string,
  value: string,
): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    if (node.getAttribute(attribute) === value) return node;
  }
  return null;
}

function waitForMessage(
  root: ParentNode,
  messageId: string,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const existing = byAttribute(root, anchors.message, anchors.messageIdAttr, messageId);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (message: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(message);
    };
    const observer = new MutationObserver(() => {
      const message = byAttribute(root, anchors.message, anchors.messageIdAttr, messageId);
      if (message) finish(message);
    });
    observer.observe(root, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function reveal(message: HTMLElement, highlightMs: number): void {
  message.scrollIntoView?.({ block: "center" });
  const active = activeHighlights.get(message);
  if (active) clearTimeout(active.timer);
  const baseline: Omit<HighlightEntry, "timer"> = active
    ? {
        attribute: active.attribute,
        outline: active.outline,
        outlineOffset: active.outlineOffset,
        transition: active.transition,
      }
    : {
        attribute: message.getAttribute("data-gpt-sidekick-highlighted"),
        outline: message.style.outline,
        outlineOffset: message.style.outlineOffset,
        transition: message.style.transition,
      };
  message.setAttribute("data-gpt-sidekick-highlighted", "true");
  message.style.outline = "3px solid #7c5cff";
  message.style.outlineOffset = "4px";
  message.style.transition = "outline-color 150ms ease";
  const timer = setTimeout(() => {
    const latest = activeHighlights.get(message);
    if (!latest || latest.timer !== timer) return;
    if (latest.attribute === null) message.removeAttribute("data-gpt-sidekick-highlighted");
    else message.setAttribute("data-gpt-sidekick-highlighted", latest.attribute);
    message.style.outline = latest.outline;
    message.style.outlineOffset = latest.outlineOffset;
    message.style.transition = latest.transition;
    activeHighlights.delete(message);
  }, highlightMs);
  activeHighlights.set(message, { ...baseline, timer });
}

/**
 * Re-locate a cited ChatGPT message through the persistent turn skeleton. The
 * message itself may be virtualized out, so the turn scroll happens first and
 * a MutationObserver waits for the exact durable message id to reappear.
 */
export async function jumpToSource(options: {
  root: ParentNode;
  messageId: string;
  turnId?: string;
  timeoutMs?: number;
  highlightMs?: number;
}): Promise<JumpResult> {
  const { root, messageId, turnId, timeoutMs = 3_000, highlightMs = 1_500 } = options;
  const present = byAttribute(root, anchors.message, anchors.messageIdAttr, messageId);
  if (present) {
    reveal(present, highlightMs);
    return { status: "found" };
  }

  if (!turnId) return { status: "not-found" };
  const turn = byAttribute(root, anchors.turn, anchors.turnIdAttr, turnId);
  if (!turn) return { status: "not-found" };

  // Install the observer before scrolling: a virtualizer may mount synchronously.
  const messagePromise = waitForMessage(root, messageId, timeoutMs);
  turn.scrollIntoView?.({ block: "center" });
  const message = await messagePromise;
  if (!message) return { status: "not-found" };
  reveal(message, highlightMs);
  return { status: "found" };
}

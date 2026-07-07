// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createLiveHydrator } from "./hydrate";

/** Let jsdom's MutationObserver callbacks (microtasks) and timers flush. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function bareTurn(id: string): { doc: Document; turn: Element } {
  const doc = new DOMParser().parseFromString(
    `<main><article data-turn-id="${id}"></article></main>`,
    "text/html",
  );
  const turn = doc.querySelector("[data-turn-id]");
  if (!turn) throw new Error("fixture missing turn");
  return { doc, turn };
}

function mountMessage(doc: Document, turn: Element, text: string): HTMLElement {
  const node = doc.createElement("div");
  node.setAttribute("data-message-id", "m-1");
  node.setAttribute("data-message-author-role", "assistant");
  const content = doc.createElement("div");
  content.setAttribute("data-message-content", "");
  content.textContent = text;
  node.append(content);
  turn.append(node);
  return content;
}

describe("createLiveHydrator — resolve contract (presence + non-empty text)", () => {
  it("does NOT resolve on an empty node, only after canonical text paints", async () => {
    const { doc, turn } = bareTurn("t-slow");
    let resolved = false;
    const p = createLiveHydrator({ timeoutMs: 1_000 })(turn).then(() => {
      resolved = true;
    });

    // t0: node mounts EMPTY — a presence-only hydrator would resolve here (the bug).
    const content = mountMessage(doc, turn, "");
    await tick();
    expect(resolved).toBe(false); // the litmus: presence alone must not satisfy the contract

    // t1: text paints in.
    content.textContent = "the answer";
    await tick();
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately when the turn is already hydrated", async () => {
    const { doc, turn } = bareTurn("t-ready");
    mountMessage(doc, turn, "already here");
    await createLiveHydrator({ timeoutMs: 1_000 })(turn); // must not hang
  });

  it("gives up (resolves, does not throw) after the timeout when a turn never hydrates", async () => {
    const { turn } = bareTurn("t-never");
    await createLiveHydrator({ timeoutMs: 15 })(turn); // capture's unstable path handles the empty turn
    expect(turn.querySelector("[data-message-id]")).toBeNull();
  });
});

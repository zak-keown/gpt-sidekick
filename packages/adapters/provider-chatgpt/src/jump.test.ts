// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { jumpToSource } from "./jump";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function documentWithTurn(): { doc: Document; turn: HTMLElement } {
  const doc = new DOMParser().parseFromString(
    `<main><article data-turn-id="turn-7"></article></main>`,
    "text/html",
  );
  const turn = doc.querySelector<HTMLElement>("[data-turn-id]");
  if (!turn) throw new Error("fixture missing turn");
  return { doc, turn };
}

function appendMessage(doc: Document, turn: Element): HTMLElement {
  const message = doc.createElement("div");
  message.setAttribute("data-message-id", "message-7");
  message.innerHTML = `<div class="markdown">the cited source</div>`;
  turn.append(message);
  return message;
}

describe("jumpToSource — virtualized source relocation", () => {
  it("scrolls and highlights an already-hydrated message", async () => {
    const { doc, turn } = documentWithTurn();
    const message = appendMessage(doc, turn);
    let scrolled = false;
    message.scrollIntoView = () => {
      scrolled = true;
    };

    const result = await jumpToSource({
      root: doc,
      messageId: "message-7",
      turnId: "turn-7",
      highlightMs: 1_000,
    });

    expect(result).toEqual({ status: "found" });
    expect(scrolled).toBe(true);
    expect(message.getAttribute("data-gpt-sidekick-highlighted")).toBe("true");
  });

  it("scrolls the persistent turn, waits for rehydration, then highlights the message", async () => {
    const { doc, turn } = documentWithTurn();
    let turnScrolled = false;
    turn.scrollIntoView = () => {
      turnScrolled = true;
      queueMicrotask(() => appendMessage(doc, turn));
    };

    const result = await jumpToSource({
      root: doc,
      messageId: "message-7",
      turnId: "turn-7",
      timeoutMs: 1_000,
      highlightMs: 1_000,
    });
    await tick();

    expect(result).toEqual({ status: "found" });
    expect(turnScrolled).toBe(true);
    expect(
      doc
        .querySelector('[data-message-id="message-7"]')
        ?.getAttribute("data-gpt-sidekick-highlighted"),
    ).toBe("true");
  });

  it("returns not-found without throwing when the persistent turn is absent", async () => {
    const doc = new DOMParser().parseFromString(`<main></main>`, "text/html");

    await expect(
      jumpToSource({
        root: doc,
        messageId: "message-7",
        turnId: "turn-7",
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ status: "not-found" });
  });

  it("returns not-found when the turn never rehydrates the requested message", async () => {
    const { doc, turn } = documentWithTurn();
    turn.scrollIntoView = () => {};

    await expect(
      jumpToSource({
        root: doc,
        messageId: "message-7",
        turnId: "turn-7",
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ status: "not-found" });
  });

  it("restores pre-existing inline styles after the temporary highlight", async () => {
    const { doc, turn } = documentWithTurn();
    const message = appendMessage(doc, turn);
    message.style.outline = "1px solid red";
    message.style.outlineOffset = "2px";
    message.style.transition = "opacity 1s";

    await jumpToSource({
      root: doc,
      messageId: "message-7",
      turnId: "turn-7",
      highlightMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(message.style.outline).toBe("1px solid red");
    expect(message.style.outlineOffset).toBe("2px");
    expect(message.style.transition).toBe("opacity 1s");
  });
});

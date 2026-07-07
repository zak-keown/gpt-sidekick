// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { capture } from "./capture";

const FIXTURE_URL = "https://chatgpt.com/c/abc123-conversation";
const UUID_SHAPED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadFixture(): Document {
  // import.meta.dirname (not import.meta.url) — under the jsdom env import.meta.url
  // is an http:// location, which fileURLToPath rejects.
  const html = readFileSync(
    join(import.meta.dirname, "../test/fixtures/synthetic-2026-07.html"),
    "utf8",
  );
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Active hydrateTurn fake: clones the matching inert <template> into the bare
 * turn wrapper, simulating scroll-triggered rehydration on the live page. A
 * turn with no template stays empty (→ unstable).
 */
function makeHydrator(doc: Document) {
  return async (turn: Element): Promise<void> => {
    const turnId = turn.getAttribute("data-turn-id");
    const tpl = doc.querySelector<HTMLTemplateElement>(
      `template[data-hydrate-for="${turnId}"]`,
    );
    if (tpl) turn.append(tpl.content.cloneNode(true));
  };
}

describe("capture — synthetic virtualized fixture", () => {
  let doc: Document;
  beforeEach(() => {
    doc = loadFixture();
  });

  it("captures every hydrated + rehydrated turn, skeleton order preserved", async () => {
    const { events } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: makeHydrator(doc),
    });

    // 6 turns; turn 5 is unstable (no template). Events: t1(1) t2(3) t3(1) t4(1) t6(1) = 7.
    expect(events.map((e) => e.role)).toEqual([
      "user", // turn 1
      "tool", // turn 2 — multi-node split
      "assistant",
      "assistant",
      "user", // turn 3 — rehydrated from template
      "assistant", // turn 4 — rehydrated from template
      "system", // turn 6
    ]);
  });

  it("reads message ids faithfully and UUID-shaped (real-UUID check is the local fixtures.local run)", async () => {
    const { events } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: makeHydrator(doc),
    });
    for (const e of events) expect(e.messageId).toMatch(UUID_SHAPED);
    // The rehydrated turn-3 message must be present — proving the scroll loop ran.
    expect(events.map((e) => e.messageId)).toContain(
      "f1e2d3c4-0003-4a03-8b03-000000000003",
    );
  });

  it("derives conversationId from the /c/<id> URL and links a dom anchor per message", async () => {
    const { events } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: makeHydrator(doc),
    });
    for (const e of events) {
      expect(e.provider).toBe("chatgpt");
      expect(e.conversationId).toBe("abc123-conversation");
      expect(e.anchor).toEqual({
        kind: "dom",
        locator: `[data-message-id="${e.messageId}"]`,
      });
    }
    // turnId links each message back to its persistent wrapper (source-jump, §5.4).
    expect(events[0]?.turnId).toBe("a1b2c3d4-0001-4001-8001-000000000001");
  });

  it("preserves code blocks verbatim while normalizing prose whitespace", async () => {
    const { events } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: makeHydrator(doc),
    });
    const codeMsg = events.find(
      (e) => e.messageId === "f1e2d3c4-0002-4a02-8b0c-00000000002c",
    );
    expect(codeMsg?.text).toContain(
      'function key(e) {\n    return e.conversationId + ":" + e.messageId;\n}',
    );
    // Prose around the code is whitespace-normalized (no runs of spaces/newlines).
    expect(codeMsg?.text).toContain("Use the durable id as the key. Example:");

    // The rehydrated turn-4 code proves preservation survives template rehydration.
    const rehydratedCode = events.find(
      (e) => e.messageId === "f1e2d3c4-0004-4a04-8b04-000000000004",
    );
    expect(rehydratedCode?.text).toContain(
      'turn.scrollIntoView({ block: "center" });',
    );
  });

  it("reports the never-hydrating turn as partial + unstable, never silent-empty", async () => {
    const { state } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: makeHydrator(doc),
    });
    expect(state).toEqual({
      kind: "partial",
      captured: 5, // 5 of 6 turns yielded a message
      expected: 6,
      unstable: ["a1b2c3d4-0005-4005-8005-000000000005"],
    });
  });
});

describe("capture — edge cases", () => {
  it("dedups a message id that appears in two turns (overlapping scroll windows)", async () => {
    const doc = new DOMParser().parseFromString(
      `<div id="thread">
        <article data-turn-id="t-1">
          <div data-message-id="dup-0001-4001-8001-000000000001" data-message-author-role="user">
            <div data-message-content>hello</div>
          </div>
        </article>
        <article data-turn-id="t-2">
          <div data-message-id="dup-0001-4001-8001-000000000001" data-message-author-role="user">
            <div data-message-content>hello</div>
          </div>
        </article>
      </div>`,
      "text/html",
    );
    const noop = async () => {};
    const { events } = await capture({ root: doc, url: FIXTURE_URL, hydrateTurn: noop });
    expect(events).toHaveLength(1);
  });

  it("re-hydrates a turn whose node is present but text has not painted (isHydrated, not presence)", async () => {
    // A presence-only skip condition would read this turn immediately and capture "".
    const doc = new DOMParser().parseFromString(
      `<div id="thread">
        <article data-turn-id="t-empty">
          <div data-message-id="m-empty-0001-4001-8001-000000000001" data-message-author-role="assistant">
            <div data-message-content></div>
          </div>
        </article>
      </div>`,
      "text/html",
    );
    const paintLate = async (turn: Element) => {
      const content = turn.querySelector("[data-message-content]");
      if (content) content.textContent = "painted after mount";
    };
    const { events, state } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: paintLate,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("painted after mount");
    expect(state.kind).toBe("complete");
  });

  it("fails loudly when no turn skeleton matches (selectors rotted)", async () => {
    const doc = new DOMParser().parseFromString(
      `<div><p>no conversation turns here</p></div>`,
      "text/html",
    );
    const noop = async () => {};
    const { events, state } = await capture({
      root: doc,
      url: FIXTURE_URL,
      hydrateTurn: noop,
    });
    expect(events).toEqual([]);
    expect(state).toEqual({ kind: "failed", reason: "no-messages-matched" });
  });
});

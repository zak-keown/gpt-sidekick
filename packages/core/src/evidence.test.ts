import { describe, expect, it } from "vitest";
import { validateOutline } from "./evidence";
import type { OutlineCandidate, TranscriptRecord } from "./model";

function record(text: string, messageId = "m1"): TranscriptRecord {
  return {
    provider: "chatgpt",
    conversationId: "c1",
    messageId,
    role: "assistant",
    text,
    turnIndex: 0,
    messageIndex: 0,
    ordinal: 0,
    capturedAt: "2026-07-07T00:00:00Z",
    textHash: "h",
    anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
  };
}

const TEXT = "we decided to use the durable id as the key";
const RECORDS = [record(TEXT)];

/** A single-evidence candidate whose quote/offsets are supplied verbatim. */
function candidate(
  quote: string,
  offsetStart: number,
  offsetEnd: number,
  messageId = "m1",
): OutlineCandidate {
  return {
    type: "decision",
    title: quote.slice(0, 20),
    summary: quote,
    evidence: [{ messageId, quote, offsetStart, offsetEnd }],
  };
}

describe("validateOutline — the Evidence Invariant", () => {
  it("keeps an item whose quote is an exact substring at its offsets", () => {
    const phrase = "use the durable id";
    const start = TEXT.indexOf(phrase);
    const { items, droppedNoEvidence } = validateOutline(
      [candidate(phrase, start, start + phrase.length)],
      RECORDS,
    );
    expect(items).toHaveLength(1);
    expect(droppedNoEvidence).toBe(0);
    expect(items[0]?.id).toBeTruthy();
  });

  it("drops an item whose quote is off by one character", () => {
    const phrase = "use the durable id";
    const start = TEXT.indexOf(phrase);
    const { items, droppedNoEvidence } = validateOutline(
      [candidate(phrase + "X", start, start + phrase.length)],
      RECORDS,
    );
    expect(items).toEqual([]);
    expect(droppedNoEvidence).toBe(1);
  });

  it("drops an item whose offsets don't bracket the quote", () => {
    const phrase = "use the durable id";
    const start = TEXT.indexOf(phrase);
    const { items, droppedNoEvidence } = validateOutline(
      [candidate(phrase, 0, start + phrase.length)], // wrong start
      RECORDS,
    );
    expect(items).toEqual([]);
    expect(droppedNoEvidence).toBe(1);
  });

  it("drops an item with empty evidence", () => {
    const c: OutlineCandidate = {
      type: "note",
      title: "x",
      summary: "x",
      evidence: [],
    };
    const { items, droppedNoEvidence } = validateOutline([c], RECORDS);
    expect(items).toEqual([]);
    expect(droppedNoEvidence).toBe(1);
  });

  it("drops an item citing a messageId that has no record", () => {
    const phrase = "use the durable id";
    const start = TEXT.indexOf(phrase);
    const { items, droppedNoEvidence } = validateOutline(
      [candidate(phrase, start, start + phrase.length, "missing")],
      RECORDS,
    );
    expect(items).toEqual([]);
    expect(droppedNoEvidence).toBe(1);
  });

  it("drops an item if ANY of several evidences fails (strict, per §4)", () => {
    const good = { messageId: "m1", quote: TEXT.slice(0, 10), offsetStart: 0, offsetEnd: 10 };
    const bad = { messageId: "m1", quote: "NOPE", offsetStart: 0, offsetEnd: 4 };
    const c: OutlineCandidate = {
      type: "decision",
      title: "t",
      summary: "s",
      evidence: [good, bad],
    };
    const { items, droppedNoEvidence } = validateOutline([c], RECORDS);
    expect(items).toEqual([]);
    expect(droppedNoEvidence).toBe(1);
  });

  it("rejects malformed offsets that JS slice would silently normalize (Codex high)", () => {
    const phrase = "durable id";
    const start = TEXT.indexOf(phrase);
    const end = start + phrase.length;
    const bad = [
      candidate(phrase, -1, end), // negative start
      candidate(phrase, start, TEXT.length + 5), // out of range end
      candidate(phrase, 1.5, end), // fractional
      candidate(phrase, Number.NaN, end), // NaN
      candidate(phrase, end, start), // reversed
      candidate("", start, start), // zero-length + empty quote
      candidate("   ", start, start + 3), // whitespace-only quote
    ];
    for (const c of bad) {
      const { items, droppedNoEvidence } = validateOutline([c], RECORDS);
      expect(items).toEqual([]);
      expect(droppedNoEvidence).toBe(1);
    }
  });

  it("counts drops while keeping the valid items in a mixed batch", () => {
    const phrase = "durable id";
    const start = TEXT.indexOf(phrase);
    const valid = candidate(phrase, start, start + phrase.length);
    const invalid = candidate("ghost quote", 0, 11);
    const { items, droppedNoEvidence } = validateOutline([valid, invalid], RECORDS);
    expect(items).toHaveLength(1);
    expect(droppedNoEvidence).toBe(1);
  });
});

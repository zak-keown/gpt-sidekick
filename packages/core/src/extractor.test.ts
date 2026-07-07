import { describe, expect, it } from "vitest";
import { extract } from "./extractor";
import { validateOutline } from "./evidence";
import type { Role, TranscriptRecord } from "./model";

let seq = 0;
function rec(text: string, role: Role = "assistant"): TranscriptRecord {
  seq++;
  return {
    provider: "chatgpt",
    conversationId: "c1",
    messageId: `m${seq}`,
    role,
    text,
    turnIndex: seq,
    messageIndex: 0,
    ordinal: seq,
    capturedAt: "2026-07-07T00:00:00Z",
    textHash: "h",
    anchor: { kind: "dom", locator: "" },
  };
}

/** The category types produced for a single message. */
function types(text: string, role: Role = "assistant"): string[] {
  return extract([rec(text, role)]).map((c) => c.type);
}

describe("RulesExtractor — categories fire on positives, stay silent on matched negatives", () => {
  it("Code fires on a fenced block; quote is the code", () => {
    const cands = extract([rec("Here is the fix:\n```\nconst x = 1;\n```")]);
    const code = cands.find((c) => c.type === "code");
    expect(code).toBeTruthy();
    expect(code?.evidence[0]?.quote).toContain("const x = 1;");
  });
  it("Code does not fire on prose that merely mentions code", () => {
    expect(types("just some prose about a const named x")).not.toContain("code");
  });

  it("Question fires on a ?-sentence, not a statement", () => {
    expect(types("Should we use Redis here?", "user")).toContain("question");
    expect(types("We are using Redis here.", "user")).not.toContain("question");
  });

  it("Action fires on an imperative marker, not on plain description", () => {
    expect(types("Let's add a retry to the client.")).toContain("action");
    expect(types("The client already retries on failure.")).not.toContain("action");
  });

  it("Decision fires on a decision marker, not on a plain fact", () => {
    expect(types("We'll go with Postgres for storage.")).toContain("decision");
    expect(types("Postgres is a relational database.")).not.toContain("decision");
  });

  it("Correction fires on a correction marker, not on a plain statement", () => {
    expect(types("Actually, that timeout should be 5s not 30s.")).toContain(
      "correction",
    );
    expect(types("The timeout is set to 5 seconds.")).not.toContain("correction");
  });

  it("Artifact fires on a markdown table, not on prose", () => {
    expect(types("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("artifact");
    expect(types("there is no table anywhere here")).not.toContain("artifact");
  });

  it("assigns one category per sentence, preferring Decision over Action", () => {
    const t = types("Let's use Postgres.");
    expect(t).toContain("decision");
    expect(t).not.toContain("action");
  });

  it("does not fire markers that appear only inside a code block", () => {
    expect(types("```\n// actually reset the counter here\nreset();\n```")).not.toContain(
      "correction",
    );
  });
});

describe("RulesExtractor ∘ EvidenceChecker — every candidate's offsets round-trip", () => {
  it("no candidate is dropped by the Evidence Invariant (offsets exact by construction)", () => {
    const records = [
      rec("Should we cache this response?", "user"),
      rec("Let's add a retry. Actually, use exponential backoff instead.", "assistant"),
      rec("We'll go with Postgres.\n```\nSELECT 1;\n```", "assistant"),
      rec("| col |\n| --- |\n| val |", "assistant"),
    ];
    const candidates = extract(records);
    expect(candidates.length).toBeGreaterThan(3);
    const { items, droppedNoEvidence } = validateOutline(candidates, records);
    expect(droppedNoEvidence).toBe(0);
    expect(items).toHaveLength(candidates.length);
  });
});

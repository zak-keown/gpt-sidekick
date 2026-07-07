// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capture } from "./capture";

// The real-capture validation gate for anchors.ts (SPEC §5.1). Runs against a
// real ChatGPT conversation saved under fixtures.local/ (git-ignored, personal
// data), so it is SKIPPED where the fixture is absent (clones/CI). Regenerate it
// with the probe/dump snippets in plans/ if the DOM churns.
const FIXTURE = join(
  import.meta.dirname,
  "../../../../fixtures.local/chatgpt/sample-01.html",
);
// Version-agnostic: real ChatGPT ids include non-v4 UUIDs (assistant ids are
// v5-shaped, e.g. …-5e4d-…), so the strict v4 check used for synthetic ids fails.
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!existsSync(FIXTURE))("capture — real ChatGPT fixture", () => {
  async function run() {
    const html = readFileSync(FIXTURE, "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    // A static snapshot: every turn is already hydrated, so the hydrator is a
    // noop (there is nothing to scroll into view).
    return capture({
      root: doc,
      url: "https://chatgpt.com/c/fixture-sample-01",
      hydrateTurn: async () => {},
    });
  }

  it("captures both turns with real durable ids and roles, marked complete", async () => {
    const { events, state } = await run();
    expect(events.map((e) => e.role)).toEqual(["user", "assistant"]);
    for (const e of events) {
      expect(e.messageId).toMatch(ANY_UUID);
      expect(e.text.length).toBeGreaterThan(0);
    }
    expect(state.kind).toBe("complete");
  });

  it("captures the user prompt as clean prose", async () => {
    const { events } = await run();
    const user = events.find((e) => e.role === "user");
    expect(user?.text).toContain(
      "Write a Python function that reverses a string",
    );
  });

  it("preserves the code block verbatim and excludes the code-toolbar chrome", async () => {
    const { events } = await run();
    const assistant = events.find((e) => e.role === "assistant");
    expect(assistant?.text).toContain("def reverse_string(s: str) -> str:");
    expect(assistant?.text).toContain("```"); // re-fenced as markdown
    // "PythonRun" = the code block's language label + Run button, chrome that
    // lives inside <pre> but outside <code>. It must not be captured as code.
    expect(assistant?.text).not.toContain("PythonRun");
    // Prose after the code block survives alongside the fenced code.
    expect(assistant?.text).toContain("edge case");
  });
});

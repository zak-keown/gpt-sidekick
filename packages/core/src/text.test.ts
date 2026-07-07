import { describe, expect, it } from "vitest";
import { normalizeText } from "./text";

describe("normalizeText — prose whitespace normalization", () => {
  it("collapses runs of spaces, tabs, and newlines into a single space", () => {
    expect(normalizeText("a  b\t\tc\n\nd")).toBe("a b c d");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeText("  \n hello world \t ")).toBe("hello world");
  });

  it("leaves already-normal prose unchanged", () => {
    expect(normalizeText("the quick brown fox")).toBe("the quick brown fox");
  });

  it("is idempotent", () => {
    const messy = "  many\n\n   spaces\tand\ttabs  ";
    const once = normalizeText(messy);
    expect(normalizeText(once)).toBe(once);
  });

  it("normalizes empty and whitespace-only strings to empty", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   \n\t  ")).toBe("");
  });
});

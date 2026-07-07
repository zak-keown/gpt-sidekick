import { normalizeText } from "@gpt-sidekick/core/text";

// Private-use sentinels (U+E000/U+E001): mark where a <pre> block sat while
// prose is normalized, then swap the verbatim code back in. Pure-ASCII source
// (fromCharCode) so the sentinels are unambiguous; vanishingly unlikely in prose.
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);

/**
 * Canonical text of a message content root (SPEC 5.3): prose whitespace is
 * normalized (via core normalizeText) so the Evidence Invariant's substring
 * test is stable, but <pre> code is copied VERBATIM -- collapsing its runs
 * would destroy the indentation/newlines the Code category depends on.
 *
 * Method: replace each <pre> with a sentinel token, normalize the remaining
 * prose, then substitute the verbatim code back at each token -- preserving
 * document order of prose and code.
 */
export function canonicalizeNode(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const codes: string[] = [];

  for (const pre of clone.querySelectorAll("pre")) {
    const index = codes.length;
    codes.push(pre.textContent ?? "");
    pre.replaceWith(
      clone.ownerDocument.createTextNode(CODE_OPEN + index + CODE_CLOSE),
    );
  }

  const normalized = normalizeText(clone.textContent ?? "");
  const tokenPattern = new RegExp(CODE_OPEN + "(\\d+)" + CODE_CLOSE, "g");
  return normalized
    .replace(tokenPattern, (_match, index: string) => `\n${codes[Number(index)] ?? ""}\n`)
    .trim();
}

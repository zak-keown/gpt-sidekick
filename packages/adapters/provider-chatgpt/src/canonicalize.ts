import { normalizeText } from "@gpt-sidekick/core/text";

// Private-use sentinels (U+E000/U+E001): mark where a <pre> block sat while
// prose is normalized, then swap the verbatim code back in. Pure-ASCII source
// (fromCharCode) so the sentinels are unambiguous; vanishingly unlikely in prose.
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);

// Block-level tags whose boundaries must become whitespace, so adjacent blocks
// (<p>A</p><p>B</p>, list items, table cells) don't merge into "AB" under
// textContent. INLINE tags (<a>, <strong>, inline <code>, <span>) are NOT here:
// separating them would fragment words mid-sentence. NOTE: inline <code> falls
// through to prose normalization (its internal spaces collapse) -- acceptable
// for the spike; only fenced <pre> code is preserved verbatim.
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function walk(node: Node, out: string[], codes: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      out.push(child.nodeValue ?? "");
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;

    const el = child as Element;
    if (el.tagName === "PRE") {
      const index = codes.length;
      // A ChatGPT code block wraps a toolbar (language label + Copy/Run button)
      // AND the <code> element inside the <pre>. Fence the <code> body so the
      // toolbar chrome ("PythonRun…", validated against a real capture) isn't
      // captured as code. Fall back to the pre's text if there is no <code>.
      const codeEl = el.querySelector("code");
      codes.push((codeEl ?? el).textContent ?? "");
      out.push(" " + CODE_OPEN + index + CODE_CLOSE + " ");
      continue;
    }
    if (el.tagName === "BR") {
      out.push(" ");
      continue;
    }

    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) out.push(" ");
    walk(el, out, codes);
    if (isBlock) out.push(" ");
  }
}

/**
 * Canonical text of a message content root (SPEC 5.3): prose whitespace is
 * normalized (via core normalizeText) so the Evidence Invariant's substring
 * test is stable, but <pre> code is copied VERBATIM -- collapsing its runs
 * would destroy the indentation/newlines the Code category depends on. Block
 * element boundaries become whitespace so adjacent blocks stay separated.
 */
export function canonicalizeNode(root: Element): string {
  const out: string[] = [];
  const codes: string[] = [];
  walk(root, out, codes);

  const normalized = normalizeText(out.join(""));
  const tokenPattern = new RegExp(CODE_OPEN + "(\\d+)" + CODE_CLOSE, "g");
  // Re-fence code so canonical text is faithful markdown AND the extractor can
  // detect code blocks (```...```). The verbatim body is unchanged. An EMPTY
  // code body contributes nothing — fencing it would make an unpainted
  // <pre><code></code></pre> read as non-empty and defeat the hydration/emit
  // guard, persisting an empty fenced block as if it were captured (Codex).
  return normalized
    .replace(tokenPattern, (_match, index: string) => {
      const code = codes[Number(index)] ?? "";
      return code.trim().length === 0 ? "" : "\n```\n" + code + "\n```\n";
    })
    .trim();
}

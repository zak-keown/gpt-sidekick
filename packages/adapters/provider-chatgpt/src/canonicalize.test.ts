// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { canonicalizeNode } from "./canonicalize";

function root(html: string): Element {
  const doc = new DOMParser().parseFromString(
    `<div id="root">${html}</div>`,
    "text/html",
  );
  const el = doc.getElementById("root");
  if (!el) throw new Error("no root");
  return el;
}

describe("canonicalizeNode — block boundaries (Codex medium)", () => {
  it("separates adjacent paragraphs instead of merging to 'AlphaBeta'", () => {
    expect(canonicalizeNode(root("<p>Alpha</p><p>Beta</p>"))).toBe("Alpha Beta");
  });

  it("separates list items", () => {
    expect(canonicalizeNode(root("<ul><li>one</li><li>two</li></ul>"))).toBe(
      "one two",
    );
  });

  it("treats <br> as a separator", () => {
    expect(canonicalizeNode(root("<div>line1<br>line2</div>"))).toBe(
      "line1 line2",
    );
  });

  it("does NOT fragment words across inline elements", () => {
    // Inline <strong>/<a>/inline <code> must not inject separators mid-phrase.
    expect(
      canonicalizeNode(root("<p>click <strong>here</strong> now</p>")),
    ).toBe("click here now");
    expect(canonicalizeNode(root("<p>use <code>npm</code> ok</p>"))).toBe(
      "use npm ok",
    );
  });

  it("normalizes prose whitespace runs", () => {
    expect(canonicalizeNode(root("<p>a   b\n\n c</p>"))).toBe("a b c");
  });
});

describe("canonicalizeNode — code preservation", () => {
  it("does not fence an empty code body (would read as false non-empty content)", () => {
    expect(canonicalizeNode(root("<pre><code></code></pre>"))).toBe("");
    expect(canonicalizeNode(root("<p>see</p><pre><code></code></pre>"))).toBe("see");
  });

  it("preserves <pre> code verbatim while separating surrounding prose", () => {
    const out = canonicalizeNode(
      root("<p>Before</p><pre><code>x = 1\n    y = 2</code></pre><p>After</p>"),
    );
    expect(out).toContain("x = 1\n    y = 2"); // indentation + newline intact
    expect(out).toContain("Before");
    expect(out).toContain("After");
  });
});

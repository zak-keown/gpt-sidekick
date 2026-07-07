/**
 * Prose whitespace normalization — the shared rule that makes the Evidence
 * Invariant's substring test meaningful (SPEC §5.3). Capture stores canonical
 * text; the M2 extractor slices that same stored text, so offsets line up.
 *
 * PROSE-ONLY on purpose. This is a pure string function with no idea which
 * characters are code — collapsing whitespace runs here would destroy code
 * indentation and newlines. Code preservation is DOM-structural and lives in
 * the provider's `canonicalizeNode` (it copies `<pre><code>` verbatim and runs
 * this only over prose segments).
 */
export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

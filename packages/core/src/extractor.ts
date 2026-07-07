import type { OutlineCandidate, OutlineType, TranscriptRecord } from "./model";

/**
 * Rules-based extractor (SPEC §6) — deliberately simple and honest about it: a
 * drop-in seam (`Extractor`) for the Alpha neural extractor. Titles/summaries
 * are EXTRACTIVE substrings only (no rewriting, §6.3). Evidence offsets are
 * sliced from the record's own canonical text, so every candidate passes the
 * Evidence Invariant by construction.
 */
export interface Extractor {
  extract(records: TranscriptRecord[]): OutlineCandidate[];
}

const FENCED_CODE = /```\n([\s\S]*?)\n```/g;
const FENCE_PREFIX_LEN = 4; // "```\n"

// Markers, checked in priority order so each sentence yields one category.
const CORRECTION =
  /\b(actually|correction|i was wrong|to clarify|let me revise|on second thought|scratch that|my mistake)\b/i;
const DECISION =
  /\b(we'?ll go with|we'?ll use|let'?s use|going with|we should use|i'?ll use|we will use|decided(?: on| to)?)\b/i;
const ACTION = /\b(let'?s|we should|next step|to-?do|action item|action:)\b/i;

type Span = { text: string; start: number; end: number };

/**
 * Replace fenced code with equal-length newlines: offsets stay aligned with the
 * original text, and sentence scanning both ignores code AND won't run a marker
 * sentence across a code block.
 */
function maskCode(text: string): string {
  return text.replace(/```\n[\s\S]*?\n```/g, (block) => "\n".repeat(block.length));
}

/** Split into sentences with offsets; newlines and .!? are boundaries. */
function sentences(text: string): Span[] {
  const spans: Span[] = [];
  const re = /[^.!?\n]*[.!?]+|[^.!?\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + (raw.length - raw.trimStart().length);
    spans.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return spans;
}

function markerCategory(sentence: string): OutlineType | null {
  if (CORRECTION.test(sentence)) return "correction";
  if (DECISION.test(sentence)) return "decision";
  if (ACTION.test(sentence)) return "action";
  if (/\?\s*$/.test(sentence)) return "question";
  return null;
}

/**
 * A short title that is a REAL PREFIX of the (trimmed) quote — so it stays an
 * exact substring of the source and passes core's display-grounding check. A
 * word-join ("first 8 words") would NOT be a substring for code (newlines /
 * indentation collapse), so it can't be used at the trust boundary.
 */
function titleFrom(quote: string): string {
  const trimmed = quote.trim();
  if (trimmed.length <= 60) return trimmed;
  const head = trimmed.slice(0, 60);
  const lastSpace = head.lastIndexOf(" ");
  return lastSpace >= 20 ? head.slice(0, lastSpace) : head;
}

function buildCandidate(
  record: TranscriptRecord,
  type: OutlineType,
  quote: string,
  offsetStart: number,
  offsetEnd: number,
): OutlineCandidate {
  return {
    type,
    title: titleFrom(quote),
    summary: quote.trim(),
    evidence: [{ messageId: record.messageId, quote, offsetStart, offsetEnd }],
  };
}

function extractCode(record: TranscriptRecord): OutlineCandidate[] {
  const out: OutlineCandidate[] = [];
  const re = new RegExp(FENCED_CODE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(record.text)) !== null) {
    const code = m[1] ?? "";
    if (!code.trim()) continue;
    const start = m.index + FENCE_PREFIX_LEN;
    out.push(buildCandidate(record, "code", code, start, start + code.length));
  }
  return out;
}

function extractProse(record: TranscriptRecord): OutlineCandidate[] {
  const masked = maskCode(record.text);
  const out: OutlineCandidate[] = [];
  for (const span of sentences(masked)) {
    const type = markerCategory(span.text);
    if (!type) continue;
    const quote = record.text.slice(span.start, span.end);
    out.push(buildCandidate(record, type, quote, span.start, span.end));
  }
  return out;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** Minimal Artifact rule (§6.1): a run of ≥2 markdown table rows. */
function extractArtifacts(record: TranscriptRecord): OutlineCandidate[] {
  const out: OutlineCandidate[] = [];
  const lines = record.text.split("\n");
  let offset = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isTableRow(line)) {
      const blockStart = offset;
      let blockEnd = offset;
      let rows = 0;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        const l = lines[i] ?? "";
        blockEnd = offset + l.length;
        offset += l.length + 1; // + newline
        i++;
        rows++;
      }
      if (rows >= 2) {
        const quote = record.text.slice(blockStart, blockEnd);
        out.push(buildCandidate(record, "artifact", quote, blockStart, blockEnd));
      }
    } else {
      offset += line.length + 1;
      i++;
    }
  }
  return out;
}

export function extract(records: TranscriptRecord[]): OutlineCandidate[] {
  const candidates: OutlineCandidate[] = [];
  for (const record of records) {
    candidates.push(...extractCode(record));
    candidates.push(...extractProse(record));
    candidates.push(...extractArtifacts(record));
  }
  return candidates;
}

export const RulesExtractor: Extractor = { extract };

import type {
  Evidence,
  OutlineCandidate,
  OutlineItem,
  TranscriptRecord,
} from "./model";

export type EvidenceValidation = {
  items: OutlineItem[];
  droppedNoEvidence: number;
};

/**
 * The Evidence Invariant, enforced once (SPEC §4). A candidate survives only
 * if it has ≥1 evidence AND every evidence's quote is an EXACT substring of its
 * cited record at the given offsets: `record.text.slice(start, end) === quote`.
 * Anything else is dropped and counted — never shown. This is the trust core;
 * weakening the equality (e.g. to `includes`) must break a currently-green
 * fixture (revert test).
 */
function evidenceHolds(
  evidence: Evidence,
  recordsById: Map<string, TranscriptRecord>,
): boolean {
  const record = recordsById.get(evidence.messageId);
  if (!record) return false;

  const { offsetStart, offsetEnd, quote } = evidence;
  // Validate the span explicitly — JS `slice` silently normalizes negative,
  // fractional, NaN, and out-of-range indexes, so a malformed span could
  // otherwise pass the equality check and break source-jump downstream.
  if (!Number.isInteger(offsetStart) || !Number.isInteger(offsetEnd)) return false;
  if (offsetStart < 0 || offsetEnd > record.text.length) return false;
  if (offsetStart >= offsetEnd) return false; // reversed or zero-length
  if (quote.trim().length === 0) return false; // whitespace-only isn't evidence

  return record.text.slice(offsetStart, offsetEnd) === quote;
}

export function validateOutline(
  candidates: OutlineCandidate[],
  records: TranscriptRecord[],
): EvidenceValidation {
  const recordsById = new Map(records.map((r) => [r.messageId, r]));
  const items: OutlineItem[] = [];
  let droppedNoEvidence = 0;

  for (const candidate of candidates) {
    const first = candidate.evidence[0];
    const valid =
      first !== undefined &&
      candidate.evidence.every((ev) => evidenceHolds(ev, recordsById));
    if (!valid) {
      droppedNoEvidence++;
      continue;
    }

    // Ground the DISPLAYED text against the validated EVIDENCE SPAN — not merely
    // the containing record. The user reads title + summary; requiring them only
    // to appear somewhere in the message would let a future extractor cite quote
    // X yet show text lifted from an unrelated sentence Y, misrepresenting what
    // the evidence supports (Codex). Both must be non-empty substrings of one of
    // the item's own evidence quotes (SPEC §6.3).
    const grounded =
      candidate.title.trim().length > 0 &&
      candidate.summary.trim().length > 0 &&
      candidate.evidence.some((ev) => ev.quote.includes(candidate.title)) &&
      candidate.evidence.some((ev) => ev.quote.includes(candidate.summary));
    if (!grounded) {
      droppedNoEvidence++;
      continue;
    }

    // Deterministic id (no host randomness in DOM-free core): stable across
    // re-index so the store upserts an item in place.
    items.push({
      ...candidate,
      id: `${candidate.type}-${first.messageId}-${first.offsetStart}`,
    });
  }

  return { items, droppedNoEvidence };
}

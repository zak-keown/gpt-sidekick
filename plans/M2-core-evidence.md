# M2 — Core + Evidence (plan)

*Milestone SPEC.md §12.3. Goal: prove **the trust core** — a `RulesExtractor` turns captured records into outline candidates, an `EvidenceChecker` enforces the Evidence Invariant (no item survives unless its quote is an exact substring of its cited record), and a `TranscriptStore` persists records + outline idempotently. Proven RED-first, Evidence-Invariant property test + revert test green. Branch: `m2-core-evidence`. Workflow: RED → GREEN → verify → Codex adversarial review → [USER GATE].*

## The milestone boundary (what M2 is / isn't)
- **M2 proves the trust core** (§12: "TranscriptStore + RulesExtractor + EvidenceChecker; outline persisted; Evidence Invariant tests + revert test green").
- Outline **UI**, grouping, source-jump, copy buttons → M3. Spike **verdict** on real chats → M4.
- The extractor is **rules-based and honest about it** (§6): extractive substrings only, no rewriting — a drop-in seam (`Extractor` interface) for the Alpha neural extractor.

## Two phases on this branch
- **M2a — trust core (pure, DOM-free, node-tested — the §12 proven-by).** `EvidenceChecker` + `RulesExtractor` + `TranscriptStore` interface + an in-memory store + the record→outline pipeline. RED-first lives here. Everything in `core` (no DOM, `types:[]`), so the Evidence Invariant is enforced once, provider-agnostic.
- **M2b — infrastructure.** Dexie `TranscriptStore` impl (browser IndexedDB; `fake-indexeddb` for tests) + **the [M1-BLOCKING] targeted-routing gate** + wiring the live pass: content-script capture → (routed) SW → side-panel store → extract → persist. Sketched here; detailed after M2a.

## Where things live (the boundary matters)
`core` is DOM-free, so IndexedDB/Dexie **cannot** live there. Split:
- **`core`** (pure, node-testable): the §4 data model types, `Extractor` interface, `RulesExtractor`, `EvidenceChecker`, `TranscriptStore` **interface**, and an `InMemoryTranscriptStore`. This is the whole trust core and the entire M2a test surface.
- **adapter (`adapters/storage-dexie`, new)**: the Dexie-backed `TranscriptStore` implementing core's interface. Swappable; exercised with `fake-indexeddb` in M2b, and in M3's e2e.
- Provider `TranscriptEvent` (`provider:"chatgpt"`) is structurally assignable to core's `TranscriptEvent` (`provider: string`) — no M1 churn; core stays provider-agnostic.

## Data model to concretize in core (§4)
```ts
type TranscriptRecord = TranscriptEvent & {
  ordinal: number;      // conversation order (assigned by the store on upsert)
  capturedAt: string;
  textHash: string;     // hash of canonical text — drift detection + Claude/Gemini reuse later
};
type OutlineCandidate = Omit<OutlineItem, "id" | "evidence"> & { evidence: Evidence[] };
// Evidence: { messageId, quote, offsetStart, offsetEnd } — quote MUST be record.text.slice(start,end)
```

## The trust seam (RED-first order, M2a)
1. **`EvidenceChecker` first — it IS the trust core.** `validate(candidates, records): { items: OutlineItem[]; droppedNoEvidence: number }`.
   - **The Evidence Invariant, testable:** for every surviving item, `evidence.length ≥ 1` and for every `Evidence`, a record with `messageId` exists and `record.text.slice(offsetStart, offsetEnd) === quote` (exact). Anything failing is **dropped**, counted in `droppedNoEvidence`, never shown.
   - RED tests: valid candidate passes; **one-char-off quote → dropped**; empty-evidence → dropped; offsets that don't match the quote → dropped; missing-record messageId → dropped.
   - **Revert test (load-bearing):** replacing the exact-substring check with something weaker (e.g. `includes`, or skipping the offset check) makes a currently-green fixture **red**. This is the M2 analogue of M1's hydrate-loop revert.
2. **`RulesExtractor`** implements `Extractor` (§6.4): `extract(records): OutlineCandidate[]`. Category rules (§6.1): Code (fenced block → item, quote = fenced content), Question (`?` in a user turn / explicit open question), Action (imperative/TODO markers), Decision (decision markers), Correction (markers only — recall honestly expected-low, §14), Artifact (minimal). Titles/summaries are **extractive substrings** (§6.3) — no rewriting. Evidence offsets computed by locating the span in the record's canonical text; **if it can't be located exactly, drop the candidate** (feeds the checker's invariant).
   - RED tests (**non-tautological**): each category fires on a positive fixture AND does **not** fire on a matched negative (no "matches everything"). Offsets computed actually round-trip through the checker (extractor + checker compose: every emitted candidate passes the invariant by construction).
3. **`TranscriptStore` interface + `InMemoryTranscriptStore`**: `upsertRecords`, `getRecords(conversationId)`, `putOutline`, `getOutline`, source-jump lookup by `[conversationId+messageId]`. **Idempotent upsert** (re-capturing a grown chat updates in place); `ordinal` assigned by skeleton/insertion order. RED tests: upsert idempotence (same event twice → one record, stable ordinal); ordering.
4. **Pipeline**: `records → RulesExtractor → EvidenceChecker → outline`, persisted. One end-to-end test on a fixture transcript: N records → K items, D dropped, every surviving item satisfies the invariant.

## M2b — infrastructure (detailed after M2a)
- **[M1-BLOCKING] targeted routing (SPEC §13) — do this before real transcript payloads cross contexts.** Replace `runtime.sendMessage` broadcast on the capture→store path with `runtime.connect` ports (or `tabs.sendMessage`) carrying source/target metadata, sender validated before dispatch, so a transcript payload reaches only its own side panel. The M0 echo RPC stays broadcast (fine for echo); the *content-bearing* path is routed.
- **Dexie `TranscriptStore`** (§7 schema: `records: '[conversationId+messageId], conversationId, ordinal'`; `outline`; `meta`). `unlimitedStorage` already deferred to this milestone (SPEC §9). Test with `fake-indexeddb`.
- **Wire the live pass**: content-script `capture(createLiveHydrator())` → routed handoff → side-panel store → extract → persist → `meta.counts {messages, items, droppedNoEvidence, unstableIds}`.

## Dependency carried from M1 (do not lose)
- **Validate the ChatGPT DOM anchors — esp. `[data-message-content]` — against a real capture before M2b consumes live capture output.** Capture now fails *closed* on a missing content root, so a wrong selector yields an all-unstable, zero-event pass. M2a is unaffected (it runs on synthetic/fixture records), but M2b's live wiring is only meaningful once the anchors are real-validated. Flagged in plans/M1-capture.md.

## Verify gates (all must pass)
- `pnpm test` — `core` evidence + extractor + store suites green; Evidence-Invariant revert-sensitive.
- `pnpm -r exec tsc --noEmit` strict; `core` still DOM-free (the Dexie impl lives in the adapter, not core).
- `pnpm build` loadable; `pnpm lint` boundaries (adapter may import `core`; `core` imports nothing).

## Exit
Codex adversarial review at the trust-core boundary → [USER GATE] → **M3 (UI + source-jump)**.

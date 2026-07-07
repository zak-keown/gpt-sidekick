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
- **[M1-BLOCKING] targeted routing (SPEC §13) — DELIVERED (routing gate).** Core gained a pure `Router` (`packages/core/src/router.ts`): attested-source stamping, a `canSend` cross-tab firewall (content@t may reach only sw or panel@t), and targeted delivery — proven headless with an isolation centerpiece test + reply round-trip, and three revert anchors (attested-source, firewall, `addressEquals` tabId). The chrome binding is `createSwPortRouter` (`adapters/host-chrome/src/router-port.ts`) over `runtime.connect`: content identity from the Chrome-attested `port.sender.tab.id` (fail-closed if absent), foreign-sender rejection, panel identity via `resolvePanelIdentity`. Fake-chrome unit test. Instantiated in `background.ts`; the M0 echo RPC stays broadcast (fine for a public string). **What it proves / doesn't:** the content→panel direction and the firewall are closed unconditionally; the panel side is NOT — see the two deferred items below. No live payloads flow through it yet (that's the live pass, gated on real anchors).
- **Dexie `TranscriptStore` — DELIVERED** (`adapters/storage-dexie`; §7 schema `records: '[conversationId+messageId], conversationId, ordinal'` + `outlines` + `meta`; CAS in a transaction). Tested with `fake-indexeddb`, incl. persistence across instances. `unlimitedStorage` returns when it's first persisted from the extension (live pass).
- **Wire the live pass** (remaining M2b): content-script `capture(createLiveHydrator())` → routed handoff → store → extract → persist → `meta.counts {messages, items, droppedNoEvidence, unstableIds}`. Gated on the real-anchor validation below.

## Deferred to live-wiring / real-fixture (do not lose)
- **Authoritative panel-tabId attestation (SPEC §13 trust boundary).** A side panel is a first-party page with no `port.sender.tab`, so `resolvePanelIdentity` currently trusts the tab id the panel declares in its `hello`. The no-cross-panel-leak guarantee is therefore *conditional on that value being correct*: a benign bug (racy `tabs.query`, focus change mid-connect, multi-window) that yields the wrong tab id routes another tab's transcript to that panel — the exact §13 leak, no attacker needed. The fix (SW assigns the panel's tab id from the sidePanel/tab it was opened for) slots into `resolvePanelIdentity` without touching the router. The headless tests prove the mechanism + the attested content side; they do NOT prove the panel side.
- **Store-location decision (kept open on purpose).** The router permits *both* content→sw and content→panel@t, so it does not bake in who owns the store. "Side-panel store" (panel-owned) loses captures whenever the panel is closed; "SW-owned store" is the more robust MV3 pattern (survives panel close, single writer) but keeps heavy work off the panel. Decide at live-wiring; the router supports either.

## Live-wiring checklist (from the routing-gate review — do NOT lose)
These are invisible until real payloads flow (fake ports don't reproduce them):
- **Guard `deliver` against a disconnected port.** `port.postMessage` *throws* on a closed port ("Attempting to use a disconnected port object"). A panel can close between a content push and its `onDisconnect` firing (disconnect is async), so the router's unguarded delivery loop would throw out of `route`, abort the loop, and drop the push. Wrap the adapter's `deliver` (try/catch) before live payloads flow — presents as intermittent lost captures otherwise.
- **Run the full Playwright e2e at the M2b boundary, not now.** There is no routed traffic to exercise yet (echo rides `onMessage`; the router rides `onConnect`; they don't interact, and the build passes). The first routed content→panel round-trip exists only after live wiring — that's the first point an e2e proves anything the unit tests don't.
- **Verify against real Chrome at live-wiring (both fail-closed, so neither is a leak — but both can wrongly disconnect legit ports):** (a) `port.sender.id` is actually populated for our own content-script connects (else the defense-in-depth check drops legitimate ports — loud, not silent); (b) bake the "first panel message MUST be the hello" contract into the client helper, since a panel that sends a `RoutedEnvelope` first gets disconnected.

## Dependency carried from M1 (do not lose)
- **Validate the ChatGPT DOM anchors — esp. `[data-message-content]` — against a real capture before M2b consumes live capture output.** Capture now fails *closed* on a missing content root, so a wrong selector yields an all-unstable, zero-event pass. M2a is unaffected (it runs on synthetic/fixture records), but M2b's live wiring is only meaningful once the anchors are real-validated. Flagged in plans/M1-capture.md.

## Known limitation — real-fixture-gated (Codex round 4, deferred not silently)
- **Within-turn `messageIndex` under *disjoint* partial hydration.** `messageIndex` is the DOM position among the turn's *currently present* message nodes. If a multi-node turn ever hydrates its nodes **disjointly across passes** (pass 1 shows only the answer → index 0; a later pass shows only earlier siblings), the answer's stored index can be wrong and siblings can misorder — unless the answer is re-captured once the full turn is present (which corrects it). This is bounded: such a turn is already flagged `unstable` (partial), and for a *completed* chat a scrolled-in turn's nodes are all final and normally render together, so the disjoint case shouldn't arise. **Whether ChatGPT hydrates a turn's nodes atomically or disjointly is unverifiable without a real multi-node fixture** — so the robust fix (a provider-stable per-message ordinal, or holding a multi-node turn's indices until the full sibling set is present and updating them atomically) is deferred to real-fixture validation, alongside the anchor-validation dependency above. Do not wire M2b's live path to rely on within-turn order for partially-hydrated turns until this is checked.

## Verify gates (all must pass)
- `pnpm test` — `core` evidence + extractor + store suites green; Evidence-Invariant revert-sensitive.
- `pnpm -r exec tsc --noEmit` strict; `core` still DOM-free (the Dexie impl lives in the adapter, not core).
- `pnpm build` loadable; `pnpm lint` boundaries (adapter may import `core`; `core` imports nothing).

## Exit
Codex adversarial review at the trust-core boundary → [USER GATE] → **M3 (UI + source-jump)**.

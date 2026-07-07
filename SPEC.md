# SPEC — GPT-Sidekick Spike (Chrome × ChatGPT)

*Status: **Draft — awaiting [USER GATE]**. Date: 2026-07-01. Scope: Product Sequence step 1 (the "Spike") from [`gpt-sidekick-product-plan.md`](./gpt-sidekick-product-plan.md); architecture/stack per [`gpt-sidekick-architecture-and-research.md`](./gpt-sidekick-architecture-and-research.md) (hereafter "the companion doc"). This spec covers **only** the spike — the narrowest slice that proves the thesis on the highest-confidence cell.*

---

## 1. Purpose — the one thing this spike proves (or kills)

**Thesis under test:** *On the ChatGPT × Chrome cell, we can capture a loaded conversation, produce a source-linked outline whose every item points to an exact substring of a real message, and jump back to that message — locally, with no cloud call.*

This is the highest-confidence starting cell precisely because **ChatGPT exposes a real server UUID (`data-message-id`) in the DOM** (companion §4.1), so the trust mechanism (the Evidence Invariant) has a solid anchor. If the loop doesn't work *here*, it won't work anywhere.

> **Empirical update — 2026-07-02** ([findings note](./findings/2026-07-02_chatgpt-virtualization.md)): first-hand capture shows ChatGPT now **virtualizes** the conversation — only a **~5-turn window is hydrated at once** (independent of chat length), though a **full skeleton of persistent `data-turn-id` wrappers** for every turn always remains in the DOM. The UUID trust anchor holds *where hydrated*, so this is still the highest-confidence cell **on identity** — but capture is no longer one-shot. Per the [USER GATE], the spike **folds in a bounded scroll-and-accumulate capture** (§5.2) rather than deferring it to Alpha. This revises companion §4's "ChatGPT · Virtualization: none".

**Kill criteria — abandon or rethink the approach if, at the end of the spike:**
- We cannot reliably resolve a captured message back to a stable DOM node for source-jump on a real, long ChatGPT conversation, **or**
- The Evidence Invariant cannot be enforced without unacceptable false-drop of legitimate outline items (i.e., the "exact substring" rule is too brittle against ChatGPT's rendered text), **or**
- A rules-only extractor produces an outline so noisy that a human judges it *net-negative* vs. scrolling the chat.

**Explicit non-goal:** the spike does **not** aim for outline *quality* at product bar — that's the embedder's job in Alpha. The spike proves the *plumbing and the trust invariant*.

---

## 2. Scope

### In scope
1. Chrome MV3 extension skeleton (WXT) with a **side panel** (Preact UI) and a **ChatGPT content script**.
2. **Scroll-and-accumulate capture** of the full ChatGPT conversation → normalized `TranscriptEvent[]`, keyed on `data-message-id`. Because ChatGPT virtualizes to a ~5-turn window (finding 2026-07-02), capture walks the persistent `data-turn-id` skeleton, hydrating each turn into view and upserting it (§5.2). A manual **"Re-index"** button re-runs the pass.
3. A **DOM-free `core`** that: stores transcript records, runs a **rules-based extractor** into `OutlineItem[]`, and enforces the **Evidence Invariant**.
4. **Local persistence** (Dexie/IndexedDB) of transcript records + outline, with a compound index enabling source-jump.
5. **Side-panel UI**: renders the outline grouped by category, with an explicit **indexing-state** indicator (`idle | capturing | indexing | ready | partial | failed`).
6. **Source-jump**: clicking an outline item scrolls the ChatGPT tab to the cited message and highlights it.
7. **Fixtures**: at least 3 real captured ChatGPT conversation snapshots (dated HTML) committed to `fixtures.local/` (git-ignored), + a small labeled subset that seeds the embedder eval ([`SPEC-embedder-eval.md`](./SPEC-embedder-eval.md)).

### Out of scope (deferred — tracked openly, "no silent caps"; see §13)
| Deferred | Lands in | Why not in spike |
|---|---|---|
| **Live capture** (MutationObserver, completion detection) | Alpha | Spike is "outline from *loaded* DOM"; one-shot + manual re-index de-risks capture without streaming complexity |
| **Neural embedder / offscreen document** | Alpha | Sequence puts the T0 embedder in Alpha; spike uses rules-only so it isn't blocked on the ML seam. **The extractor is a seam (§6.4) so the embedder drops in without touching core's contract.** The embedder choice is decided *in parallel* by [`SPEC-embedder-eval.md`](./SPEC-embedder-eval.md) |
| ~~**Best-effort backfill**~~ → **now in spike scope** (bounded scroll-and-hydrate) | ~~Alpha~~ **Spike** | Premise reversed by the 2026-07-02 finding: ChatGPT *virtualizes*, so a scroll pass is **required** to capture a full chat — folded into §5.2 per the [USER GATE]. (Open-ended *lossy* backfill of unloadable history remains Alpha; the persistent skeleton makes the spike's pass bounded & deterministic, not lossy.) |
| **Per-site `optional_host_permissions` opt-in UX** | Alpha | Spike hard-codes a single `chatgpt.com` host permission; the opt-in polish (companion §5.1) is an Alpha concern |
| **Multi-provider / multi-browser / VS Code** | Later phases | Spike is one cell |
| **Export importer** (`conversations.json`) | Alpha+ | Backfill/sanctioned-source adapter (companion §12.1) is later |
| **Canvas capture** | Alpha | ChatGPT canvas renders in a separate pane (companion §4.1); spike captures the message stream only |

---

## 3. Architecture (the slice)

The spike exercises four of the monorepo packages from companion §2, keeping the boundaries real from day one:

```
packages/
  core/                     pure TS, DOM-free: TranscriptStore, RulesExtractor, EvidenceChecker, types
  adapters/provider-chatgpt DOM allowed: capture loaded conversation → TranscriptEvent[]; resolve source anchor
  adapters/host-chrome      MV3 wiring: content script ⇄ side panel messaging, Dexie storage impl of core's Host port
  ui/                       Preact side-panel: outline view + indexing state + source-jump trigger
apps/
  chrome-spike/             WXT entrypoints (sidepanel, content script, background SW router) → the shippable .zip
```

**Runtime topology (spike subset of companion §1.3):**
```
[ content script @ chatgpt.com ]  capture loaded DOM → TranscriptEvent[]; execute source-jump on request
        │  ▲
        ▼  │  runtime messaging (JSON)
[ service worker ]                THIN ROUTER: relay capture payload ↔ side panel; no heavy work
        │  ▲
        ▼  │
[ side panel (Preact) ]           core runs HERE for the spike (rules extractor is light); Dexie read/write; render
        │
        ▼
[ IndexedDB (Dexie) ]             transcript records + outline
```

> **Spike simplification, stated honestly:** the rules extractor is cheap, so for the spike **`core` runs in the side-panel page** (a normal extension document) rather than an offscreen document. The **offscreen document is introduced in Alpha with the embedder** (companion §1.3/§12.3), because *that* is the multi-second job that must survive the service worker's 30 s idle-kill. Core must therefore stay DOM-free and host-agnostic (§2 of companion) so relocating it into the offscreen doc in Alpha is a wiring change, not a rewrite.

---

## 4. Data model

Reuse the plan's types verbatim where given; concretize the rest. All in `core` (no DOM types).

```ts
// The normalized event the provider adapter emits (plan's TranscriptEvent).
type TranscriptEvent = {
  provider: "chatgpt";
  conversationId: string;
  messageId: string;                 // ChatGPT data-message-id (server UUID) — the durable key
  role: "user" | "assistant" | "system" | "tool";
  text: string;                      // canonical plain text of the message (see §5.3)
  createdAt?: string;
  anchor: { kind: "dom"; locator: string };  // spike: locator = `[data-message-id="<uuid>"]`
};

// Stable stored record.
type TranscriptRecord = TranscriptEvent & {
  ordinal: number;                   // position in the captured conversation (tie-breaker / ordering)
  capturedAt: string;
  textHash: string;                  // hash of canonical text — drift detection + Claude/Gemini reuse later
};

// Plan's OutlineItem + Evidence, made precise.
type OutlineItem = {
  id: string;
  type: "decision" | "action" | "question" | "artifact" | "code" | "correction" | "note";
  title: string;                     // short, human-facing
  summary: string;                   // spike: extractive (a representative span), NOT reworded (companion §7)
  evidence: Evidence[];              // MUST be non-empty (Evidence Rule)
  createdAt: string;
};

type Evidence = {
  messageId: string;                 // must resolve to a TranscriptRecord
  quote: string;                     // MUST be an exact substring of that record's canonical text
  offsetStart: number;               // index of quote within canonical text
  offsetEnd: number;
};

// Honest capability declaration for this cell (plan's ProviderCapabilities), asserted by a test.
const CHATGPT_CAPS = {
  liveCapture: false,                // spike: one-shot only (true in Alpha)
  readLoadedHistory: true,
  bestEffortBackfill: false,         // spike (true/N-A in Alpha)
  fullServerHistory: false,          // export-only, not wired in spike
  stableMessageIds: "yes",
  sourceJump: true,
} as const;
```

**The Evidence Invariant (the trust core, testable):**
> For every `OutlineItem`, `evidence.length ≥ 1`, and for every `Evidence`: a `TranscriptRecord` with `messageId` exists, and `record.text.slice(offsetStart, offsetEnd) === quote` (exact). An item that cannot satisfy this is **dropped, not shown** — surfaced in the indexing state as "N candidates dropped (no evidence)", never silently.

---

## 5. Capture — the ChatGPT provider adapter

### 5.1 Anchors (as of 2026-07, **expect churn** — companion §4.1)
Resolve by **durability tier**, never by hashed classes:
- **Turn/message identity:** `article[data-message-id]` is not the rule — the durable key is the attribute **`data-message-id` (server UUID)** on the message node; `data-message-author-role` gives the role. Ordering only: `data-testid="conversation-turn-{N}"` (positional — never use as identity).
- **Per-turn anchor (new — 2026-07-02):** every turn wrapper carries a durable **`data-turn-id` (UUID)** that *persists even when the turn's content is virtualized out* — unlike `data-message-id`, which is present only while the turn is hydrated. Drive capture and source-jump by scrolling the `data-turn-id` skeleton; use `data-message-id` as the message identity once hydrated. (Verify `data-turn-id` stability across reload before trusting it as server-backed.)
- **Critical trap:** *one visual turn can wrap multiple message nodes* (tool → reasoning → answer). Within each hydrated turn, **iterate its `[data-message-id]` nodes, not the turn** — the `data-turn-id` drives *scrolling*, the `data-message-id`s are the *identities*.
- Selectors live in ONE file (`provider-chatgpt/anchors.ts`) with an `AS_OF = "2026-07"` constant and a comment pointing at the fixture that validates them.

### 5.2 Capture algorithm (scroll-and-accumulate)
ChatGPT virtualizes to a ~5-turn hydrated window but keeps a **persistent skeleton** of `[data-turn-id]` wrappers for *every* turn (finding 2026-07-02). So capture is a bounded, deterministic pass over that skeleton — not a single `querySelectorAll`:
1. Find the thread scroll container and the ordered list of `[data-turn-id]` wrappers — its length **N is the true conversation length** (known up front, without scrolling).
2. For each wrapper in document order: if not hydrated, `scrollIntoView({block:'center'})` and await hydration (a `[data-message-id]` node appears with non-empty canonical text). Then, for each `[data-message-id]` node in the turn, read `data-message-id`, `data-message-author-role`, canonical text (§5.3), and the owning `data-turn-id`; emit a `TranscriptEvent` (`anchor.locator = '[data-message-id="' + id + '"]'`, plus `turnId` for re-location, §5.4).
3. **Idempotent upsert** each event into the store keyed on `[conversationId+messageId]` (§7) — re-capturing a turn across passes is safe. The DOM never holds the whole chat at once, but the store **accumulates** it.
4. Derive `conversationId` from the URL (`/c/<id>`); assign `ordinal` by skeleton order.
5. **Completeness canary (new):** compare captured message-turn count to N. If fewer than N turns yielded a message after the pass, set state `partial` with `{captured, expected: N}` — never silent-empty. (This is the missing canary the old one-shot algorithm lacked: turn-count vs message-count.)
6. **Resilience:** if zero `[data-turn-id]` wrappers match, set state `failed:no-messages-matched` (selectors rotted). A turn that never hydrates after scroll is captured as `local:<ordinal>` flagged `unstable` (no durable source-jump; counted in the state).
7. Stream `TranscriptEvent`s to the side panel via the SW router as the pass progresses (show scroll progress in the indexing state, §8).

> **Seam note:** the scroll pass runs in the **content script** (it needs the DOM); the SW stays a thin router. This does not change the spike's decision to run `core` in the side-panel page (§3) — *capture* touches the DOM, *extraction* does not.

### 5.3 Canonical text
`text` must be **stable and human-readable** so the Evidence Invariant's substring test is meaningful:
- Use `textContent` of the message's content root with normalized whitespace (collapse runs, trim), **preserving code-block contents** (fenced) since Code is an outline category.
- The SAME canonicalization runs in capture and in the extractor — a single `canonicalize(node|string)` function — so offsets computed by the extractor line up with stored text. This is a correctness linchpin; it gets its own unit test.

### 5.4 Source-jump execution (content script side)
Because a cited message is usually **virtualized out** (only ~5 turns hydrated), source-jump is async and multi-step, not a bare `querySelector`:
1. On `jumpTo({messageId, turnId})`: try `document.querySelector('[data-message-id="<id>"]')`. If present → `scrollIntoView({block:'center'})` + temporary highlight (~1.5 s). Done.
2. If absent (**the common case**): locate the persistent `[data-turn-id="<turnId>"]` wrapper, `scrollIntoView` it to force re-hydration, await the `[data-message-id]` node reappearing, then highlight. The panel shows a **"re-locating source…"** state (§8) meanwhile.
3. If the turn-id wrapper itself isn't found (navigated away / different conversation), reply `not-found` → panel shows "source not on screen". This graceful-degrade path also carries forward to Claude/Gemini (companion §3.2).

---

## 6. Extractor — rules-based (spike tier)

The spike extractor is **deliberately simple and honest about it** (companion §7: embeddings-only is already extractive; rules-only is a further-simplified spike stand-in). It exists to (a) prove the Evidence loop end-to-end and (b) be a drop-in seam for the Alpha embedder.

### 6.1 Category rules (first pass — tune against fixtures)
- **Code** — message contains a fenced code block (`\`\`\``) → item per block; quote = the fenced content (or a bounded head).
- **Question** — sentence ends `?` and is in a user turn, or an assistant sentence explicitly posing an open question.
- **Action** — imperative / TODO markers ("let's", "we should", "next step", "TODO", "action:", checkbox lines).
- **Decision** — decision markers ("we'll go with", "decided", "let's use X", "going with").
- **Correction** — self-correction markers ("actually", "correction", "I was wrong", "to clarify", "let me revise", "on second thought"). *(Known weak category — companion §7/§12.6; the pairwise NLI pipeline is an Alpha upgrade, not spike scope. Spike relies on markers only and reports correction recall as expected-low.)*
- **Artifact** — tables, or assistant-produced named deliverables; spike may keep this minimal.

### 6.2 Item construction
For each match: `type`, an extractive `summary` (the matched sentence/span, trimmed), a `title` (first ~8 words), and **one `Evidence`** = `{ messageId, quote, offsetStart, offsetEnd }` computed against the record's canonical text. Compute offsets by locating the span in canonical text; if it can't be located exactly, **drop the candidate** (Evidence Invariant) and increment the dropped counter.

### 6.3 No hallucinated titles/summaries
Spike titles/summaries are **extractive substrings only** — no rewriting (which a rules engine can't do faithfully anyway). This keeps the spike honest to the Evidence Rule and avoids pretending at abstractive quality the embedder tier also can't deliver (that's T1/T2, companion §12.5).

### 6.4 The seam (so Alpha's embedder is a drop-in)
```ts
interface Extractor {
  extract(records: TranscriptRecord[]): OutlineCandidate[]; // candidate = OutlineItem minus validated evidence
}
```
`RulesExtractor` implements it now; `NeuralOutlineExtractor` (Alpha) implements the same interface. `core` runs `EvidenceChecker.validate(candidates, records)` after either extractor, so the Evidence Invariant is enforced **once, in core**, independent of extractor.

---

## 7. Storage (Dexie / IndexedDB)

Per companion §2/§4 (Dexie 4.x; compound index for source-jump; `unlimitedStorage`).

```ts
// db.version(1).stores(...)
records: '[conversationId+messageId], conversationId, ordinal'  // compound PK → O(log n) source lookup
outline: 'id, conversationId, type'
meta:    'conversationId'   // { capturedAt, capsSnapshot, counts: {messages, items, droppedNoEvidence, unstableIds} }
```
- Manifest declares `unlimitedStorage` (companion §5). `navigator.storage.persist()` is Alpha polish (Firefox/Safari need it; Chrome covered by `unlimitedStorage`).
- Re-index is **idempotent** on `[conversationId+messageId]` (upsert), so re-capturing a grown conversation updates in place.

---

## 8. Side-panel UI (Preact)

- **Outline view:** items grouped by category, in conversation order within a group; each shows title + a one-line evidence quote preview.
- **Click → source-jump** (§5.4), which usually must scroll a virtualized-out message back into view — show a transient **"re-locating source…"** state, then highlight (or "source not on screen" on failure). Hover shows the full quote.
- **Indexing-state banner** (explicit, always visible): `idle | capturing | indexing | ready | partial | failed(reason)`, plus counts (`M messages · K items · D dropped-no-evidence · U unstable-ids`). During the capture pass, show scroll progress (`captured / expected N turns`). "partial" = the pass finished with captured < N (some turns never hydrated), or messages captured with unstable ids.
- **Re-index button.** **Copy buttons** on items (companion MVP list: copyable decision text / checklist / code).
- Styling: vanilla-extract, small (companion §2). No design polish beyond legible — this is a spike.

---

## 9. Manifest / permissions (spike)

- MV3, WXT-generated. `side_panel`. Background SW as router.
- **[UPDATED 2026-07-07, Codex adversarial review — least-privilege per milestone]** Grant each capability in the milestone that first *uses* it, not up front. The earlier "declare `storage`/`unlimitedStorage`/`scripting` + `host_permissions` now to avoid manifest churn" is reversed — WXT regenerates the manifest from config on every build, so churn is trivial, and an installed/shared echo build should not carry ChatGPT page access + unbounded storage for capabilities no code path exercises.
  - **M0 manifest:** `permissions: ["sidePanel"]` only. The inert `chatgpt.com` content-script seam carries its own host access via its `matches` pattern (no separate `host_permissions` key needed while nothing calls a host-gated API).
  - **M1:** re-add explicit `host_permissions: ["https://chatgpt.com/*"]` when targeted `tabs.sendMessage` routing lands (the [M1-BLOCKING] item in §13).
  - **M2:** add `unlimitedStorage` with Dexie/IndexedDB (`storage` permission is not required for IndexedDB itself). `scripting` only if a path ever needs `chrome.scripting.executeScript` — the declarative content script does not.
  - Alpha moves host access to `optional_host_permissions` per-site opt-in (companion §5.1).
- **No `offscreen`** in the spike (rules-only; added in Alpha with the embedder).
- CSP: default MV3; `'wasm-unsafe-eval'` **not yet needed** (no WASM until the embedder) — added in Alpha.

---

## 10. Success criteria (measurable)

The spike **passes** when, on **3 real ChatGPT conversations** (incl. one long chat — ~74 turns, the longest available; the "150+" relaxed per the [USER GATE] §14 — and one with tool/reasoning multi-node turns):
1. **Capture completeness (via scroll pass):** after a scroll-and-accumulate pass over a **virtualized long chat**, ≥ 99% of the `[data-turn-id]` skeleton's N turns are captured with a stable `data-message-id`; `failed`/`partial`/`unstable` paths behave as specified (broken selector → `failed:no-messages-matched`; a turn forced to never hydrate → counted in `partial {captured, expected:N}`, not silent-empty).
2. **Evidence Invariant holds 100%:** every rendered item's quote is an exact substring of its cited record; a property test over fixtures finds **zero** violations; deliberately corrupting a stored quote makes the checker drop the item (revert-sensitive).
3. **Source-jump works — including to virtualized-out messages:** clicking an item whose message is *not currently hydrated* re-locates it via `data-turn-id`, re-hydrates, scrolls, and highlights the correct message (Playwright e2e + one manual real-session check on a message scrolled far out of the window).
4. **Multi-node-turn correctness:** a turn containing tool→reasoning→answer yields items keyed to the right `data-message-id`, not merged under a turn index (regression test against that fixture).
5. **Local-only:** network panel shows **zero** outbound requests carrying conversation content during capture/index (asserted by an e2e that fails if any fetch/XHR leaves with message text).
6. **Human judgment:** on the **longest real chat (~74 turns; the "150+" relaxed per §14)**, a reviewer agrees the outline is *net-useful for recovering the thread* (qualitative gate, not automated).

---

## 11. Test plan (TDD, RED-first — per the repo workflow)

Every phase starts with a **failing test that asserts real behavior** (not a tautology), then GREEN, then `pnpm test` + `tsc --noEmit` strict + build. Independent adversarial review (`codex:codex-rescue`) at the phase boundary, then [USER GATE].

- **`core` (Vitest, node env):**
  - `canonicalize` idempotence + whitespace/code-preservation.
  - `EvidenceChecker`: valid item passes; item with a one-char-off quote is dropped; empty-evidence item is dropped. **Revert test:** breaking the substring check turns a currently-green fixture red.
  - `RulesExtractor`: each category fires on a positive fixture and does **not** fire on a matched negative (no tautological "matches everything").
- **`provider-chatgpt` (Vitest, jsdom, against `fixtures.local/*.html`):**
  - captures N expected messages from a dated fixture; asserts ids are the real UUIDs; multi-node-turn fixture yields the right per-message split; broken-selector fixture → `failed:no-messages-matched`.
  - **Snapshot the parsed *result object*, not raw HTML** (companion §2), so cosmetic markup churn doesn't break the test but a real selector break does.
- **e2e (Playwright, extension loaded, Chromium):** load a captured ChatGPT page locally → open panel → assert outline renders → click item → assert scroll+highlight on the right node → assert **no** content-bearing network egress. Side-panel automation is inferred (companion §2, [L]) — if the API is unreliable, fall back to driving the panel page directly by URL.
- **Fixtures:** `fixtures.local/chatgpt/<YYYY-MM-DD>_<scenario>.html` + `.meta.json` (url, capturedAt, build). **Never committed** (git-ignored per repo rule). ⚠️ **Under virtualization a single `outerHTML` dump captures only the ~5-turn window** — the `capture-fixture` script (Playwright) must **scroll the whole thread and stitch each turn's hydrated markup** (or serialize the accumulated `TranscriptEvent[]`) to produce a full-conversation fixture. A first real capture exists (`2026-07-02_long-150plus.html`) but is **window-only** and must be re-captured this way.

---

## 12. Milestones (suggested; each ends at a codex review + [USER GATE])

1. **M0 — skeleton:** WXT monorepo, empty side panel opens on chatgpt.com, SW router echoes a message. (proves wiring)
2. **M1 — capture:** `provider-chatgpt` captures a dated fixture into `TranscriptEvent[]`; unit tests green. (proves the durable-id capture)
3. **M2 — core + evidence:** `TranscriptStore` (Dexie) + `RulesExtractor` + `EvidenceChecker`; outline persisted; Evidence Invariant tests + revert test green. (proves the trust core)
4. **M3 — UI + source-jump:** panel renders grouped outline, indexing state, copy buttons; click → scroll+highlight; e2e green. (proves the full loop)
5. **M4 — spike verdict:** run success criteria §10 on 3 real chats; write a one-page **findings note** (what held, what churned, kill-criteria status) → decide **proceed to Alpha / rethink**. Emit the labeled fixture subset for [`SPEC-embedder-eval.md`](./SPEC-embedder-eval.md) — and **explicitly confirm its §4 data floors are met** (≥ 300 labeled snippets, ≥ 30 per Task-A category, ≥ 2 boundary-labeled conversations) before the embedder eval is greenlit; if the spike's 3 chats can't produce that, capture/label more first rather than run the eval on thin data.

---

## 13. Deferrals ledger (open, not hidden)

Live capture · neural embedder + offscreen doc · backfill scrolling · per-site permission opt-in UX · export importer · canvas capture · multi-provider/host · `navigator.storage.persist()` · WASM CSP. Each is listed against the phase that owns it in §2. None is dropped; each is *sequenced*.

**[M1-BLOCKING] Targeted RPC routing before real payloads flow.** The M0 RPC seam uses `chrome.runtime.sendMessage` broadcast. Globally-unique request ids (added in M0 hardening after the Codex adversarial review) stop reply *mis-resolution* across contexts, but a reply still reaches *every* context's memory — broadcast *exposure*. That is harmless for echo strings but is a privacy/tenant-isolation bug the moment real transcript/outline payloads travel over the wire. **Before M1 sends any captured content through RPC, switch to targeted/port routing** (`tabs.sendMessage` to the specific tab, or per-context `runtime.connect` ports with routed replies). This is a gate on M1, not a nice-to-have. (Codex "surface send failures" item is consciously deferred too: a dead-SW send degrades to a bounded timeout wait rather than an instant reject — acceptable at M0's 5 s default, revisit if it hurts UX.)

---

## 14. [USER GATE] decisions — resolved 2026-07-02

1. **Spike core location → side-panel page.** `core` (rules extractor, light) runs in the side-panel page for the spike; the offscreen document is introduced in Alpha with the embedder (the multi-second job that must survive the SW's 30 s kill). Core stays DOM-free/host-agnostic so the Alpha relocation is wiring, not a rewrite (§3).
2. **Correction category → included, marker-only "preview".** Ships in the spike categories using discourse markers only ("actually", "wait", "correction", …), recall honestly reported as expected-low; the pairwise-NLI upgrade is Alpha (companion §12.6).
3. **Gate set → 3 real chats:** the captured 74-turn chat (the "long" case), one with tool/reasoning **multi-node turns** (for the §10.4 regression), and one more for variety — user nominates the specific chats. **§10.6's "150+ message" bar is relaxed to the user's longest real chat (~74 turns)** — no longer chat exists.
4. **Labeling (embedder eval) → bootstrap + spot-correct** — rules extractor seeds draft labels, user corrects; guidelines committed (SPEC-embedder §4/§13).
5. **Similarity-dedup (Task C) → out of Alpha T0 scope** → the embedder eval **excludes Task C** with a written note; decision rests on Tasks A+B (SPEC-embedder §3/§9/§13).
6. **Bundling threshold → spec default** (point ≤ 2.0 F1 **and** paired upper-CI ≤ ~4.0; SPEC-embedder §1/§9/§13).

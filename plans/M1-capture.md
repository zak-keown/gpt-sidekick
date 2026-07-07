# M1 — Capture (plan)

*Milestone SPEC.md §12.2. Goal: prove **durable-id capture** — `provider-chatgpt` turns a virtualized ChatGPT DOM into `TranscriptEvent[]` keyed on the server `data-message-id`, with an honest capture-state (complete / partial / failed), proven RED-first by unit tests against a committed synthetic fixture. Branch: `m1-capture`. Workflow: RED → GREEN → verify (`pnpm test` + strict `tsc` + build) → Codex adversarial review → [USER GATE].*

## The milestone boundary (what M1 is / isn't)
- **M1 proves the capture *logic*** (SPEC §12: "captures a dated fixture into `TranscriptEvent[]`; unit tests green"). It is DOM-parsing proven in jsdom, not a live scroll.
- **Store (Dexie), extractor, EvidenceChecker → M2.** Outline UI, source-jump → M3.
- Capture emits `TranscriptEvent[]` (§4) + a `CaptureState`. It does **not** cross the RPC boundary in M1 (see the routing gate below), so no transcript payload rides `runtime.sendMessage` yet.

## Two phases on this branch
- **M1a — capture core (unit-tested, the §12 deliverable).** anchors + `normalizeText` + `canonicalizeNode` + `capture()`. No RPC, no live DOM. This is where RED-first lives.
- **M1b — live integration.** Content-script scroll-drive hydrator (`scrollIntoView` → await hydration) **+ resolves the [M1-BLOCKING] targeted-routing gate** (SPEC §13) so capture output can reach the side panel/store without broadcast. Ends the milestone at the Codex review + [USER GATE]. Sketched here; detailed after M1a is green.

## Fixture policy — refinement (needs a nod)
SPEC §11 says fixtures live in git-ignored `fixtures.local/` and are "never committed" — but that rule assumes **real captures** (personal data). A committed test suite cannot depend on git-ignored files (green only on this machine, red on a clean clone).
- **Resolution:** commit a **synthetic, hand-authored** ChatGPT-shaped fixture (`packages/adapters/provider-chatgpt/test/fixtures/synthetic-2026-07.html`) with **no personal data** — the privacy rule doesn't apply to it. Real git-ignored `fixtures.local/*.html` captures stay for local real-data validation and the M4 verdict on 3 real chats.
- **The fixture must model virtualization, or the test is a fraud (advisor).** A fully-hydrated fixture + a no-op `hydrateTurn` degenerates `capture()` to `querySelectorAll('[data-message-id]')` — the exact last-window-only bug the 2026-07-02 finding exists to kill — and still goes green. So:
  - Some turns are **pre-hydrated** (`[data-turn-id]` wrapper *with* `[data-message-id]` nodes).
  - Others are **bare `[data-turn-id]` placeholders**; their real content sits in an inert `<template data-hydrate-for="<turnId>">` — which `document.querySelectorAll('[data-message-id]')` **cannot see** (template content is a detached fragment), exactly like a virtualized-out turn.
  - The test's `hydrateTurn(turn)` is an **active fake**: it finds the matching template and injects its `[data-message-id]` node into the wrapper — simulating scroll-triggered rehydration.
  - One placeholder has **no template** → never hydrates → `unstable`.
  - Also encodes: a **multi-node turn** (tool → reasoning → answer under one wrapper), fenced **code** blocks, all four roles.
- **Litmus (same discipline as the M0 broadcast test):** deleting the `await hydrateTurn(turn)` call must turn the capture test **red** (placeholder turns vanish). If it stays green, the test isn't testing capture.

## Modules (M1a)
```
packages/core/src/
  text.ts            normalizeText(s): PROSE-ONLY whitespace collapse + trim. Pure, DOM-free, idempotent.
  text.test.ts       RED: idempotence + prose whitespace collapse (node env). NO code logic here.
packages/adapters/provider-chatgpt/src/
  anchors.ts         selectors + AS_OF="2026-07", each pointing at the validating fixture. NO hashed classes.
  canonicalize.ts    canonicalizeNode(el): segment the content — normalize prose via core normalizeText,
                     copy <pre><code> VERBATIM (code preservation is DOM-structural, cannot live in a pure
                     string normalizer: collapsing runs would destroy indentation/newlines). (DOM)
  capture.ts         capture({root, url, hydrateTurn}) -> CaptureResult { events, state }. Dedup by messageId.
  capture.test.ts    RED: jsdom, snapshots the RESULT OBJECT (not HTML), against the synthetic fixture.
```

## `capture()` contract (the seam)
```ts
type CaptureState =
  | { kind: "complete" }
  | { kind: "partial"; captured: number; expected: number; unstable: string[] }
  | { kind: "failed"; reason: "no-messages-matched" };

type CaptureResult = { events: TranscriptEvent[]; state: CaptureState };

// hydrateTurn is REQUIRED (not a no-op default — a silent no-op on a real page would
// vanish every unhydrated turn into `unstable`, the newId-default footgun class). Real
// content script does scrollIntoView + await hydration (M1b); tests pass an active fake.
function capture(opts: {
  root: ParentNode;
  url: string;                                  // -> conversationId via /c/<id>
  hydrateTurn: (turn: Element) => Promise<void>;
}): Promise<CaptureResult>;
```
Rules (SPEC §5.2): walk `[data-turn-id]` in document order (**N = true length, known up front**); per turn, if it has no `[data-message-id]` yet, `await hydrateTurn(turn)`; then iterate its `[data-message-id]` nodes (multi-node split — do **not** key by turn); read id, `data-message-author-role`, `canonicalizeNode`, owning `turnId`; emit `TranscriptEvent` (`anchor.locator='[data-message-id="<id>"]'`). **Dedup by `messageId` within the pass** — a real scroll revisits overlapping windows, so the same id can hydrate twice; emit once. `ordinal` by first-seen skeleton order. **Canary:** message-bearing turns vs N → `partial` if short. Zero turns matched → `failed:no-messages-matched`. A turn still empty after `hydrateTurn` → flagged `unstable` (its turnId), counted, never silent-empty.

## RED-first order (M1a)
1. `core/src/text.test.ts` → RED (module missing) → implement `normalizeText` → GREEN; revert-sensitive (break whitespace collapse → red).
2. Author the synthetic fixture (pre-hydrated + placeholder-with-`<template>` + no-template + multi-node + code).
3. `capture.test.ts` (jsdom) asserting the **result-object snapshot**: all N turns captured **including placeholder turns hydrated via the active `hydrateTurn` fake**; ids faithfully read + UUID-**shaped** (not "real UUIDs" — synthetic; the real-UUID check is the local `fixtures.local` run); the multi-node turn splits into 3 events with correct roles; **code content preserved verbatim** (indentation/newlines intact); `conversationId` from URL; ordinals in first-seen order; **a turn hydrated twice → one event** (dedup). → RED → implement `anchors`+`canonicalize`+`capture` → GREEN.
4. **The load-bearing revert (advisor litmus):** deleting the `await hydrateTurn(turn)` call must turn the test **red** (placeholder turns vanish) — this proves the scroll loop, unlike an id-corruption revert which never exercises hydration.
5. Negatives (non-tautological): broken-selector fixture → `failed:no-messages-matched`; the no-template turn → counted `unstable`, not dropped silently.
6. Vitest env: `@vitest-environment jsdom` pragma (add `jsdom` dev dep to `provider-chatgpt`); `core` tests stay node env. `core` remains DOM-free (jsdom lives only in the provider package's test env, not in `core`'s lib).

## M1b — live hydrator (detailed after M1a; independent of the routing gate — advisor)
`capture()` runs entirely in the content script and returns events **locally**, so the live scroll pass can be built and e2e'd **without touching routing**. Keep these two independent:

**(1) Live `hydrateTurn` + its resolve-contract — the M1b correctness crux.**
- The content script's real `hydrateTurn` scrolls the `data-turn-id` skeleton (`scrollIntoView({block:'center'})`) and awaits rehydration.
- **Resolve condition is presence *plus* non-empty canonical text** (SPEC §5.2 step 2), not presence alone. M1a's signal is presence-only — fine for the synthetic fake (content injected atomically) but wrong on the live page, where a `[data-message-id]` node can mount a beat before its text paints. `capture()` silently trusts the hydrator to guarantee non-empty-before-resolve, so make that an **explicit, tested contract**.
- **M1b litmus (same spirit as M1a's hydrate-loop revert):** a hydrator that resolves on presence alone, against a slow-rendering turn, must produce a wrong result the test catches.
- **Open decision for M1b:** also put the non-empty check *inside* `capture()` (treat present-but-empty as not-yet-captured / `unstable`) as defense for a pre-hydrated-but-still-rendering turn? Unlikely for a *completed* chat, but cheap insurance. Currently `capture()` keys unstable off `messageNodes.length === 0` only.
- Live check: Playwright against a **locally-served** stitched fixture page (chatgpt.com itself stays auth/Cloudflare-blocked, per M0), or a manual real-session pass. Fixture capture uses the scroll-and-stitch `capture-fixture` script (§11), not a one-shot `outerHTML` (which grabs only the ~5-turn window).

**(2) [M1-BLOCKING → M2 handoff] targeted routing (SPEC §13).** The gate fires on the **cross-context handoff** (capture → panel/store), which is **M2's first move**, *not* the M1b scroll pass. Before capture output crosses `runtime.sendMessage`, switch that path to **targeted routing** — `runtime.connect` ports (or `tabs.sendMessage`) carrying source/target metadata, sender validated before dispatch — so a transcript payload reaches only its own panel. Do not hold the live hydrator hostage to this redesign.

## Pending empirical follow-ups (from the 2026-07-02 finding — run alongside M1b, inform but don't block M1a)
- **`data-turn-id` stability across reload** — decides whether it's a *durable* source-jump anchor or only in-session. If it rotates on reload, source-jump (M3) needs a fallback.
- **Cold-open hydrated-window size** on an existing long chat (the 62/74 "at load" number was an in-session artifact). Confirms the resting window is ~5 regardless, i.e. the scroll pass is mandatory.

## Verify gates (all must pass)
- `pnpm test` — `core` text suite + `provider-chatgpt` capture suite green; capture revert-sensitive.
- `pnpm -r exec tsc --noEmit` strict; `core` still DOM-free (provider's jsdom env doesn't leak into core).
- `pnpm build` — still a loadable `.zip` (content script now non-inert but guarded).
- `pnpm lint` — boundaries hold (`provider-chatgpt` may import `core`, not `ui`/`host-chrome`).

## Exit
Codex adversarial review at the capture boundary → [USER GATE] → **M2 (core + evidence: store + RulesExtractor + EvidenceChecker)**, whose first cross-context handoff (capture → store) is gated on M1b's targeted routing landing.
```

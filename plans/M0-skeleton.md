# M0 — Skeleton & wiring (plan, awaiting approval)

*Milestone SPEC.md §12.1. Goal: prove the runtime wiring — WXT monorepo builds, the four package boundaries are real and compile, `core` is provably DOM-free, and a message **round-trips side-panel ⇄ SW router**. No capture, no storage, no extractor yet. Workflow: RED-first TDD → GREEN → verify (`pnpm test` + `tsc --noEmit` strict + `wxt build` + e2e) → `codex:codex-rescue` review → [USER GATE].*

## Definition of done
1. `pnpm install && pnpm build` produces a loadable MV3 extension `.zip` (the shippable per §3).
2. All four packages (`core`, `adapters/provider-chatgpt`, `adapters/host-chrome`, `ui`) + `apps/chrome-spike` exist as real, separately-compiling boundaries.
3. **`core` is provably DOM-free** — its tsconfig has no `DOM` lib and `types: []`; a would-be `document` reference fails to compile; `eslint-plugin-boundaries` fails a `core → adapters/ui` import.
4. **RED→GREEN:** the correlation-ID RPC test (below) went red first, then green, and is **revert-sensitive** (breaking correlation turns it red).
5. **e2e:** the side-panel page sends `{kind:'echo'}` through the SW router and renders the echoed reply; Playwright asserts the round-trip.
6. Manifest configures the side panel for `chatgpt.com` (opens on-site — manual check, since automating chatgpt.com is Cloudflare/login-blocked; the automated echo runs against the panel page for reliability, per §11's [L] note).
7. `codex:codex-rescue` review clean + [USER GATE] passed.

## Stack (pinned per companion §2; only what M0 needs)
- **pnpm workspaces + Turborepo 2.x**, Node 20+, TypeScript **strict**.
- **WXT 0.20.x** (MV3, cross-browser-ready), **Preact 10.x** (+ `preact/compat`) + **vanilla-extract**.
- **Vitest 4.x** (core = node env), **Playwright 1.x** (`channel: 'chromium'`).
- Deferred to later milestones, **not** installed in M0: Dexie (M2), Transformers.js/ORT (Alpha), web-ext (Firefox, later).

## Layout created
```
package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
eslint.config.js (boundaries) · vitest.workspace.ts
packages/
  core/            src/protocol.ts (RPC seam) + protocol.test.ts ← RED first · tsconfig: lib ES2023, no DOM, types:[]
  adapters/
    provider-chatgpt/  src/index.ts  → capture() stub throws NotImplemented (M1 seam; will grow the scroll-and-accumulate pass, §5.2)
    host-chrome/       src/transport.ts → chrome.runtime transport implementing core's send/onMessage (thin)
  ui/              src/SidePanel.tsx → minimal Preact component (echo box)
apps/chrome-spike/
  wxt.config.ts · manifest via WXT
  entrypoints/ background.ts (thin SW router) · chatgpt.content.ts (empty seam, matches chatgpt.com) · sidepanel/ (Preact mount)
  e2e/ wiring.spec.ts (Playwright echo round-trip)
```

## The message seam (why the RED test is here, not a tautology)
Companion §1.2: the messaging LCD is one-way JSON `send` + `subscribe`; **`core` layers correlation-ID RPC on top.** So M0 lands that RPC primitive — the seam everything later rides on — as **pure, testable** code in `core`, independent of Chrome.

- `core/src/protocol.ts`: `Envelope = { id, kind, payload }`; `createRpc(transport: { send, onMessage })` returns `{ request(kind, payload): Promise<reply>, handle(kind, fn) }`, correlating replies to requests by `id`.
- `host-chrome/src/transport.ts`: implements `{ send, onMessage }` over `chrome.runtime` (thin; exercised by e2e, not unit-tested in M0).
- `apps/chrome-spike/entrypoints/background.ts`: the **thin SW router** — relays envelopes between side panel and content script; for M0 it services the `echo` kind.

**RED-first test — `core/src/protocol.test.ts`** (fails before `protocol.ts` exists / before correlation works):
1. `createRpc(fakeInMemoryTransport)`: `request('echo', 'hi')` resolves to `'hi'`.
2. **Correlation integrity:** two concurrent `request`s with out-of-order replies each resolve to *their own* payload (not crossed). ← the non-tautological core; deliberately breaking id-matching makes this red.
3. An unmatched/late reply is dropped, not mis-resolved.

Fake transport = two paired `send/onMessage` queues; no Chrome, runs in Vitest node env in ms.

## Build order (RED first)
1. Scaffold root workspace enough to run Vitest + `tsc`.
2. **Write `protocol.test.ts` → run → RED** (module missing).
3. Implement `protocol.ts` → **GREEN**; confirm revert-sensitivity by breaking correlation.
4. Scaffold WXT app: `wxt.config.ts`, manifest (§9 perms: `sidePanel`, `scripting`, `host_permissions: https://chatgpt.com/*`; declare `storage`/`unlimitedStorage` now to avoid manifest churn — unused until M2), background SW router, empty content-script seam, Preact sidepanel mounting `ui/SidePanel`.
5. `host-chrome` transport + wire panel→SW echo.
6. **Write `e2e/wiring.spec.ts` → RED → GREEN**: load unpacked build, open panel page, assert echoed reply renders.
7. Verify gates → codex review → [USER GATE].

## Verify gates (all must pass)
- `pnpm test` — `core` protocol suite green.
- `pnpm -r exec tsc --noEmit` — strict, all packages; `core` DOM-free proven (add-then-remove a `document` ref to confirm it fails).
- `pnpm build` (`wxt build`) — loadable `.zip`.
- `pnpm e2e` — echo round-trip green.
- `pnpm lint` — boundaries rule fails on a deliberate `core → ui` import (then removed).

## Explicitly OUT of scope for M0 (no silent caps)
Capture (M1) · scroll-and-accumulate + `data-turn-id` skeleton walk (M1, §5.2) · Dexie/storage (M2) · `RulesExtractor` + `EvidenceChecker` (M2) · real outline UI, grouping, source-jump, "re-locating source…" state (M3) · content-script ⇄ SW round-trip against a real page (M1, needs a local fixture — chatgpt.com is auth/Cloudflare-blocked). `provider-chatgpt` and `host-chrome` ship as **typed stubs that throw `NotImplemented`**, so the seams are real but empty.

## Risks / calls
- **Playwright + MV3 side-panel automation is [L]** (companion §2/§11). Mitigation baked in: the e2e drives the **panel page by extension URL** and asserts the panel↔SW echo, rather than depending on the `sidePanel.open()` automation path. On-site "opens on chatgpt.com" is a manual check.
- **WXT 0.20 API surface** — use `defineBackground` / `defineContentScript` / WXT entrypoints; pin the version to avoid drift.
- Keeping the content-script seam matched to `chatgpt.com` but inert avoids requesting broad perms before M1 needs them.

## Exit
`codex:codex-rescue` adversarial review at the boundary → [USER GATE] → proceed to **M1 (capture)**, which is where the 2026-07-02 virtualization finding lands as real work (the scroll-and-accumulate pass, §5.2, + the two pending reload confirmations).

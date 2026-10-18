# HANDOFF — GPT-Sidekick

_Updated: 2026-07-12 · Branch of record: `main`_

## Current state

The Chrome × ChatGPT spike now has a complete automated product loop:

1. The content script passively captures hydrated ChatGPT messages and supports
   an explicit bounded **Re-index** over the persistent `[data-turn-id]` skeleton.
2. The service worker owns IndexedDB storage, extraction, Evidence Invariant
   validation, per-tab authorization, progress state, and targeted commands.
3. The panel groups outline items, previews grounded evidence, reports honest
   indexing state, copies summaries, and requests source-jumps.
4. Source-jump can scroll a persistent turn back into view, wait for the exact
   `data-message-id` to rehydrate, highlight it, and restore prior inline styles.

Automated gates are green:

- 125 Vitest unit, integration, and component tests.
- Strict TypeScript and package-boundary lint.
- Production WXT build and zip.
- Two Chromium e2e tests: service-worker connectivity and the built-extension
  capture → SW/Dexie → grouped panel → source-highlight journey.

What automation does **not** prove is authenticated ChatGPT's current long-chat
virtualizer, streaming behavior, and real side-panel identity. That is the next
gate—not more architecture work.

## Next: close the live-browser gate

Use a long, innocuous ChatGPT conversation with code and, ideally, a multi-node
tool/reasoning/answer turn.

1. Run `pnpm build`.
2. In `chrome://extensions`, enable Developer mode and load unpacked from
   `apps/chrome-spike/.output/chrome-mv3`.
3. Open the conversation and the GPT-Sidekick panel.
4. Click **Re-index** and record:
   - expected and captured turn counts;
   - unstable-turn count;
   - time until Ready/Partial;
   - whether the original reading position is restored acceptably.
5. Click outline items sourced from early, middle, and late turns. At least one
   source must be virtualized out before clicking. Confirm it rehydrates,
   scrolls into view, and highlights the exact message.
6. While ChatGPT is streaming a response, confirm passive capture settles to the
   final text without duplicate or stale outline items.
7. Repeat once after switching tabs/windows and once after allowing the service
   worker to restart.

Watch the ChatGPT tab console for:

```text
[gpt-sidekick] full captured N → indexed { ... }
```

### Live-gate exit criteria

- At least 99% of the long chat's turn skeleton captures with stable message IDs.
- Any miss is surfaced as Partial/Failed rather than silently omitted.
- Virtualized-out source-jump succeeds for early, middle, and late evidence.
- No cross-tab outline is shown during tab/window switching.
- Streaming converges to the final response without persistent duplicates.

If these hold, write `findings/<date>_spike-verdict.md` with the measurements and
an explicit **proceed to Alpha / rethink** verdict.

## If the live test fails

Bisect in this order:

1. **No capture log:** inspect the five selectors in
   `packages/adapters/provider-chatgpt/src/anchors.ts` against the live DOM.
2. **Captured but no indexed reply:** inspect the content port, service worker,
   and routed RPC timeout/error.
3. **Indexed but blank panel:** inspect the panel's tab identity and the ephemeral
   `tab → conversationId` mapping.
4. **Re-index stalls on a turn:** capture that turn's structural HTML and add a
   regression fixture before changing hydration timing.
5. **Jump reports not-found:** check whether `data-turn-id` remained present and
   stable, then whether the cited `data-message-id` returned after scrolling.
6. **Wrong source highlights:** stop and treat it as a trust-boundary defect;
   reproduce with a failing test before modifying routing or selector logic.

Real captures contain personal data. Keep them only under the git-ignored
`fixtures.local/chatgpt/` directory.

## After the live gate: ordered backlog

### 1. M4 usefulness verdict

Evaluate three real conversations, including the longest available. Measure
items per 100 turns, category precision/noise, duplicates, missed decisions, and
whether a reviewer can recover the thread faster than by rereading it.

Do not start the neural extractor merely because the seam exists. First determine
whether rules extraction is already useful and which categories actually need
better recall.

### 2. Reliability and privacy hardening

In order:

1. Replace self-declared panel tab identity with an authoritative assignment or
   another Chrome-attested design; cover multi-window and active-tab changes.
2. Persist indexing state/count metadata so a service-worker restart does not
   reset the panel to Idle or require a fresh DOM mutation.
3. Add `unlimitedStorage` or implement an explicit quota/eviction policy.
4. Add delete-current-conversation and delete-all-data controls.
5. Add IndexedDB migration tests before advancing the schema beyond version 1.
6. Commit structural DOM probe and fixture-generation scripts under `scripts/`.
7. Add CI for test, typecheck, lint, build, and browser e2e.

### 3. Extraction-quality dataset

Label enough real snippets to measure category quality rather than tune from
anecdotes. The embedder-eval floor remains:

- at least 300 labeled snippets;
- at least 30 examples per non-code Task-A category;
- at least two boundary-labeled conversations of 40+ turns.

Likely rules work before ML: role-aware question detection, duplicate suppression,
and superseded/open-state handling for decisions and questions.

### 4. Alpha scope

Only after the spike verdict and data floor:

1. Per-site `optional_host_permissions` opt-in UX.
2. On-device embedder evaluation from `SPEC-embedder-eval.md`.
3. Sanctioned `conversations.json` import adapter.
4. Claude provider adapter to prove the provider boundary.

Defer Firefox, Gemini, coding-agent surfaces, sync, and abstractive generation
until the ChatGPT Alpha demonstrates repeat use.

## Known assumptions still open

- A real side panel's `sender.url` matches the extension-page gate.
- `chrome.tabs.query({ active: true, currentWindow: true })` identifies the
  intended tab in real side-panel, tab-switch, and multi-window use.
- A long active hydration pass does not fight ChatGPT's virtualizer or leave the
  user at an unexpected scroll position.
- Multi-node turns hydrate atomically enough for DOM-order `messageIndex` to stay
  correct; disjoint partial hydration remains fixture-gated.
- The 800 ms trailing debounce converges cleanly during real streaming.

## Key files

| Concern | File |
| --- | --- |
| Evidence Invariant | `packages/core/src/evidence.ts` |
| Rules extractor | `packages/core/src/extractor.ts` |
| Store service and command/state contract | `packages/core/src/service.ts` |
| Targeted routing | `packages/core/src/router.ts`, `packages/adapters/host-chrome/src/router-port.ts` |
| Capture and hydration | `packages/adapters/provider-chatgpt/src/capture.ts`, `packages/adapters/provider-chatgpt/src/hydrate.ts` |
| Source relocation | `packages/adapters/provider-chatgpt/src/jump.ts` |
| Live content wiring | `apps/chrome-spike/entrypoints/chatgpt.content.ts` |
| Panel UI | `packages/ui/src/OutlinePanel.tsx` |
| Browser journeys | `apps/chrome-spike/e2e/wiring.spec.ts` |

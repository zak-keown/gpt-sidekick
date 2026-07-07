# HANDOFF — GPT-Sidekick

_Last updated: 2026-07-07. Branch of record: `main`. All gates green: 109 tests, strict tsc, boundary lint, build, e2e._

## TL;DR

The full **SW-owned trust seam is built, reviewed, and verified headless**, and the
extension **builds and loads**. Capture, targeted routing, the store, the Evidence
Invariant, the live-outline push, and the panel↔SW round-trip all work and are
tested. **The one thing left before "it visibly works end to end" is a manual
load-test on a live chatgpt.com conversation** — that path (real virtualized DOM +
scroll hydration + streaming) is the only thing that can't be automated
(chatgpt.com blocks automation), so it needs a human with the extension loaded.

## What's built and proven (headless)

- **Capture** (`adapters/provider-chatgpt`) — walks the persistent `[data-turn-id]`
  skeleton, keys on durable `data-message-id` UUIDs, canonicalizes prose + code.
  **Validated against a real ChatGPT capture** (2026-07-07): the content-root anchor
  was corrected to `.markdown, .whitespace-pre-wrap`, and code-block toolbar chrome
  ("PythonRun…") is now stripped by fencing the inner `<code>`.
- **Routing** (`core/router` + `host-chrome`) — attested source, cross-tab firewall,
  targeted delivery; revert-anchored trust tests. A Codex review hardened it: reads
  are authorized per attested tab, and content-scripts can't masquerade as panels
  (positive `sender.url` check).
- **Store service** (`core/service` + `storage-dexie`) — upsert → extract → Evidence
  Invariant → persist → counts; SW→panel live-outline push; ephemeral
  `tab→conversationId` map. Proven end-to-end over the real router with fake ports.
- **Live wiring** (`apps/chrome-spike`) — content script captures + pushes; panel
  reads + renders a minimal outline. e2e proves the panel completes a routed
  round-trip through the booted SW.

## The immediate next action: manual load-test

1. `pnpm build`
2. `chrome://extensions` → Developer mode → **Load unpacked** →
   `apps/chrome-spike/.output/chrome-mv3`
3. Open a **real chatgpt.com conversation** (ideally a long one, and one with code),
   open the GPT-Sidekick side panel, and **scroll the conversation**.
4. Open the ChatGPT tab's DevTools console and watch for
   `[gpt-sidekick] captured N → indexed {…}`.

**Bisecting a blank panel** (the log is designed for this):

- No `captured` log at all → capture found nothing: re-check the anchors against the
  live DOM (re-run the probe below). Content/DOM side.
- `captured N` but no `indexed {…}` reply (or a timeout error) → the routed
  content→SW→panel seam. Confirm the SW is alive and the content port connected.
- `captured N → indexed {items: …}` but the panel stays empty → the panel side:
  check `fetchConversationId` (tab→conversation map) and that the panel's tab id
  matches the content tab (single-window assumption below).

## Watch-list (documented assumptions to verify in real Chrome)

These are fail-safe (loud/empty, not silent-wrong) but unverified on a live page:

1. **`port.sender.tab.id` is populated for the content-script connect.** The security
   foundation; conventional MV3, but nothing green exercises a real content connect.
2. **A real side panel's `sender.url` is `chrome-extension://<id>/sidepanel.html`.**
   The panel-masquerade fix rejects the panel path otherwise → a dead panel. If the
   panel never connects, check this first.
3. **Panel tab id via `chrome.tabs.query({active,currentWindow})` is self-declared.**
   Correct for a single window with the panel open on the ChatGPT tab; tab-switch /
   multi-window misroutes. Authoritative SW-assigned attestation is deferred (see
   `resolvePanelIdentity` and `plans/M2-core-evidence.md`).
4. **Scroll-and-accumulate over a 74-turn virtualized thread** isn't exercised by the
   static 2-turn fixture (`createLiveHydrator` only runs live). `turnIndex` =
   position in the full skeleton, confirmed stable across scroll windows, so ordering
   should hold — but verify the outline accumulates cleanly as you scroll.
5. **Streaming churn** — the ~800ms trailing debounce should land captures after a
   response settles; a mid-stream capture self-heals (upsert + CAS re-index). Tune
   the debounce if the outline looks janky during generation.

## Regenerating the local anchor fixture

Real captures are personal data and live only in `fixtures.local/chatgpt/`
(git-ignored). The `capture.real.test.ts` gate skips when the fixture is absent
(clones/CI), and runs when present. To (re)generate after a ChatGPT DOM change:

- **Probe** (structural, no message text) — paste in the chatgpt.com DevTools console
  to validate the 5 anchors in `anchors.ts`. Reports counts of `[data-turn-id]`,
  `[data-message-id]`, `data-message-author-role`, `[data-message-content]` (should
  be 0 — it was assumed), plus the user/assistant content-container structure.
- **Dump** — saves the conversation container's `outerHTML` to a download; move it to
  `fixtures.local/chatgpt/sample-01.html`. Use a **throwaway/innocuous chat** (it
  contains message text).

(The exact snippets are in the 2026-07-07 session history; both are short and
self-contained. Worth committing them to `scripts/` next.)

## Go-forward roadmap

1. **Manual load-test** (above) → fix whatever the live DOM surfaces (most likely a
   selector tweak or the panel-tabId/`sender.url` real-Chrome checks). This closes
   M2b and gives the first real spike verdict.
2. **M3 — outline UI + source-jump.** Replace the minimal list with grouped items
   (by type/section), a **source-jump** that scrolls the ChatGPT tab to the cited
   message (panel→content routing already exists: `canSend(panel@t, content@t)`), and
   copy buttons. The `anchor` on each event (`[data-message-id="…"]`) is the jump target.
3. **M4 — spike verdict.** Judge outline usefulness on real long chats; decide whether
   rules extraction suffices or the neural `Extractor` is needed (recall is honestly
   expected-low for Correction/Decision categories — §14).
4. **Then:** authoritative panel-tabId attestation; store-eviction (`unlimitedStorage`);
   provider seam for Claude/Gemini (the `textHash` reuse is already in the model).

## Key files

| Concern | File |
| --- | --- |
| Evidence Invariant | `packages/core/src/evidence.ts` |
| Rules extractor + seam | `packages/core/src/extractor.ts` |
| Targeted routing (trust) | `packages/core/src/router.ts`, `packages/adapters/host-chrome/src/router-port.ts` |
| Store-service contract | `packages/core/src/service.ts` |
| ChatGPT DOM anchors | `packages/adapters/provider-chatgpt/src/anchors.ts` |
| Canonicalization | `packages/adapters/provider-chatgpt/src/canonicalize.ts` |
| Content-script wiring | `apps/chrome-spike/entrypoints/chatgpt.content.ts` |
| Panel wiring | `apps/chrome-spike/entrypoints/sidepanel/main.tsx`, `packages/ui/src/OutlinePanel.tsx` |
| Milestone plans + deferred items | `plans/M2-core-evidence.md` |

# Finding: Live-browser gate — authenticated chatgpt.com load test

*Date: 2026-08-11 · HANDOFF "close the live-browser gate" checklist · Tester: Nate · Status: gate NOT closed — 1 blocker fixed, 1 architectural premise falsified*

## Why we looked

All automated gates are green (125 Vitest, strict tsc, boundary lint, WXT build,
2 Chromium e2e). What automation does not prove: authenticated ChatGPT's current
long-chat virtualizer, streaming behavior, and real side-panel identity
(HANDOFF §"Next: close the live-browser gate"). This run closes that gate.

## Method

- Build: `pnpm build` @ commit e6e6b7a, loaded unpacked from
  `apps/chrome-spike/.output/chrome-mv3`.
- Chrome version: Chrome/150.0.0.0 (macOS)
- Conversation used: "Insightful Product Name Ideas" (`/c/baeb1401…`) —
  **28 turns**, 0 code blocks, no multi-node turns (28 distinct turn ids == 28
  distinct message ids). Real thread scroller `scrollHeight` 11156 /
  `clientHeight` 596, i.e. **heavily virtualized**: only 5–13 turns are in the
  DOM at once. (An initial measurement mistakenly identified an inner wrapper as
  the scroller and read this as a non-scrollable 5-turn chat; the corrected
  largest-overflow scan found the true scroller. Worth knowing for anyone
  writing DOM probes here — pick the scroller by largest overflow, not by the
  first ancestor with any overflow.)
- Single window, single ChatGPT tab, no other ChatGPT tab open (confirmed with
  the tester), so panel identity is not a confound in these results.

## Measurements

### 1. Re-index pass

Not measurable as specified — see BUG #2. `expected` is derived from the turns
currently in the DOM, which is a moving window (5–13), not the conversation
length (28), so the panel's `x/y` is not a completeness measure at all.

| Metric | Value |
| --- | --- |
| True conversation turns | 28 |
| Turns in DOM at once | 5–13 (5 while parked at the bottom) |
| Panel report while 4+ turns were uncaptured | `Ready · 24 messages · 7 items · 0 dropped` |
| Unstable turns reported | 0 |
| Console line | `[gpt-sidekick] passive captured 5 → indexed …` (clean, no errors post-fix) |

### 2. Source-jump (early / middle / late; ≥1 virtualized out before clicking)

Not reachable: an evicted turn loses its `[data-turn-id]` wrapper as well as its
message node, so `jumpToSource` returns `not-found` before it can observe for
rehydration (BUG #2, consequence 3). Verified by direct eviction check rather
than by clicking, since the outcome is structural.

### 3. Streaming convergence

Not tested — blocked behind BUG #2; testing convergence is not meaningful while
capture completeness is unsound.

### 4. Tab/window switch + SW restart

- SW restart: **passes after the BUG #1 fix** — the panel recovers on its own
  and reports `Ready`, where before the fix it was permanently stuck on `Idle`
  with Re-index rejected.
- Tab/window switch and cross-tab isolation: not tested this session.

## Exit criteria (HANDOFF)

- [ ] **FAIL** — ≥99% of the long chat's turn skeleton captured with stable
      message IDs. 24 of 28 turns (~86%) at the time of the reading, and the
      figure is a by-product of incidental scrolling, not a bounded pass.
- [ ] **FAIL (most serious)** — any miss surfaced as Partial/Failed. The panel
      reported `Ready` on an incomplete capture, with 0 unstable.
- [ ] **FAIL** — virtualized-out source-jump. Structurally unreachable once the
      turn wrapper is evicted.
- [ ] Not tested — no cross-tab outline during tab/window switching.
- [ ] Not tested — streaming convergence.

## Anomalies / notes

### BUG #1 (confirmed, BLOCKER): content-script port never reconnects after SW shutdown

Passive capture ran fine for ~3 minutes after page load
(`[gpt-sidekick] passive captured 5–12 → indexed …` on every mutation debounce),
then the MV3 service worker was torn down and every subsequent capture failed
permanently:

```text
[6:23:42 PM] [gpt-sidekick] capture/push failed: Error: Attempting to use a
disconnected port object
    at Object.send (content-scripts/chatgpt.js:1:5844) …
[6:23:42 PM] [gpt-sidekick] state report failed: Error: Attempting to use a
disconnected port object
```

Root cause: `connectRouted()` (adapters/host-chrome/src/routed-rpc.ts) calls
`chrome.runtime.connect` ONCE at content-script startup and never listens for
`port.onDisconnect` to reconnect. When Chrome reclaims the idle SW, the port
dies and the content script keeps posting into it forever. The page must be
reloaded to recover — passive capture silently stops working for the rest of
the tab's life. The panel side has the same single-connect pattern.

Impact: HANDOFF's "allow the service worker to restart" checklist item fails
at the transport layer, before the (already-known) state-reset limitation is
even reached. Fix shape: reconnect-on-disconnect (with the panel re-sending its
`hello`), or a lazy connect-per-send wrapper.

- First observed: passive logs 6:20:42–6:23:01 PM OK, dead port 6:23:42 PM.
- **Reproduced deterministically after a page reload**: healthy captures
  6:25:50–6:25:55 PM, then dead port from 6:27:04 PM onward — i.e. the extension
  survives roughly **70 seconds** of idle before permanently breaking. This
  matches Chrome MV3's ~30 s idle service-worker shutdown.

#### The full failure cascade (why the panel is stuck on "Idle")

Observed live: panel reports `Idle` and **Re-index is rejected** with "Open or
scroll a ChatGPT conversation before re-indexing." That is
`registerStoreService`'s `reindex` handler returning `{accepted:false}` because
`tabConversation.has(source.tabId)` is false. The chain:

1. SW idles out after ~30 s → torn down.
2. Content-script port dies; no `onDisconnect` → **never reconnects**.
3. SW wakes on the panel's next RPC with an EMPTY ephemeral `tabConversation`
   map (`service.ts` — rebuilt only from content-script pushes).
4. The content script can no longer push, so the map can **never** be
   repopulated.
5. Every panel read (`conversation`, `outline`, `indexState`) and `reindex`
   therefore fails authorization/lookup forever.

Net effect: **the extension is unusable more than ~30 s after a page load.**
Only a full page reload restores it, and then only for another ~30 s of idle.
This blocks every remaining item on the live-gate checklist — capture counts,
source-jump, streaming, and the SW-restart pass — so the gate CANNOT be closed
until it is fixed.

#### Fix applied (RED-first, this session)

`connectRouted` now reconnects instead of holding one dead port for the life of
the context (`packages/adapters/host-chrome/src/routed-rpc.ts`):

- first connect stays **eager**, so an idle client is still reachable for
  SW→client re-index/jump commands;
- `onDisconnect` clears the port and the next `send` opens a fresh one —
  **lazy**, so we never hold the SW awake just to keep a socket open;
- a `send` that throws on an already-dead port retries once on a new port;
- a panel replays its `hello` on **every** connection (a fresh SW instance has
  no memory of the earlier one and would otherwise drop the port as a bad
  handshake).

Two RED-first tests added in `routed-rpc.test.ts` under "surviving
service-worker teardown", with a `killServiceWorker()` fake that kills live
ports (making `postMessage` throw exactly as Chrome does) and drops the SW's
`onConnect` listeners so a genuinely fresh SW instance must be booted.
Revert-sensitivity checked: making the `hello` fire only on the first connect
reds the panel test alone (1 failed / 18 passed) and nothing else.

Gate after the fix: 124 Vitest passed (was 122), strict tsc clean, lint clean,
WXT build clean.

**Live re-verification after reloading the rebuilt extension:** the panel
reached `Ready · 24 messages · 7 items · 0 dropped` — i.e. the panel now gets a
conversation id, an outline, and honest counts where before the fix it was
permanently stuck on `Idle` with Re-index rejected. Passive capture continues to
log cleanly (6:38:11 / 6:38:17 / 6:38:34 PM, no dead-port errors).

Residual (documented in the code, not fixed): between the SW dying and the
client's next send, an SW→client push has no route and is dropped. No data is
lost — the store is durable and the panel refetches on its next interaction —
but a panel left untouched across an SW teardown can show stale state until it
next talks to the SW. Persisting the SW's ephemeral `tab → conversation` map
(already item 2 on HANDOFF's reliability backlog) would close this.

- Also note: `console.debug` is invisible at DevTools' default log level —
  Verbose must be enabled to see any `[gpt-sidekick]` output (worth a README
  note; cost us the first 10 minutes of the session).

### BUG #2 (confirmed, ARCHITECTURAL): the `data-turn-id` skeleton is NOT persistent

**The premise the whole capture design rests on is no longer true.**
`anchors.ts` documents `[data-turn-id]` as the "persistent per-turn skeleton
wrapper — survives virtualization", and `capture()` treats
`root.querySelectorAll(anchors.turn).length` as "the true conversation length,
known up front". As of **2026-08-11, Chrome 150, chatgpt.com**, that is false:
ChatGPT evicts the **turn wrapper together with the message**.

Measured on the live conversation (`/c/baeb1401…`, real thread scroller
`scrollHeight` 11156 / `clientHeight` 596) by stepping the scroller top→bottom
in 13 samples and accumulating distinct ids:

| Metric | Value |
| --- | --- |
| Distinct `data-turn-id` seen across a full scroll pass | **28** |
| Distinct `data-message-id` seen across the same pass | **28** |
| `[data-turn-id]` present in the DOM at any one moment | **5–13** |
| Turn wrappers in DOM while parked at the bottom | **5** |

`distinctTurns === distinctMessages` at every sample: wrappers and messages
appear and disappear **together**. Direct eviction check — record the top turn's
id, scroll to the bottom, re-query:

```text
topTurnIdRecordedAtTop: "aaa20de2-a1be-41d5-8025-f8adf774f9f3"
afterScrollingToBottom: { turnWrapperStillInDom: false,
                          messageStillInDom: false, turnsInDom: 5 }
```

#### Consequence 1 — the honesty guarantee is broken (silent under-report)

`capture()` derives `expected` from the turns currently in the DOM. Parked at
the bottom that is 5; if those 5 are hydrated then `capturedTurns === expected`,
so `state = {kind:"complete"}` and the panel renders **`Ready`**. Observed
live: the panel showed

```text
Ready · 24 messages · 7 items · 0 dropped
```

for a conversation with **28** turns. It asserted completeness while missing
~14% of the thread, with no Partial, no `unstable`, and no canary. This
directly fails the HANDOFF exit criterion "Any miss is surfaced as
Partial/Failed rather than silently omitted" — and it fails in the most
dangerous direction, since a trust-first product just told the user its
incomplete outline was complete. The 24 was itself an accumulation artifact of
incidental scrolling, not a principled capture; a user who never scrolls gets a
last-window-only outline still labelled `Ready`.

Note this is the *same* canary the 2026-07-02 finding identified ("the missing
canary is exactly turn-count vs message-count") — that canary has now been
defeated too, because the turn count is itself windowed.

#### Consequence 2 — Re-index cannot reach the whole conversation

`runCapture("full")` iterates only the turns already in the DOM and calls
`createLiveHydrator()`, which works by `turn.scrollIntoView()`. **You cannot
scroll to an element that does not exist**, so the bounded skeleton walk can
never reach an evicted turn. Re-index is structurally incapable of capturing a
long conversation, however long it runs.

#### Consequence 3 — source-jump to an evicted turn fails

`jumpToSource()` falls back to the turn wrapper as its scroll target when the
message is gone (`byAttribute(root, anchors.turn, …)`). With the wrapper
evicted too, that lookup returns null and the function returns `not-found`
immediately — it never even installs the rehydration observer. The exit
criterion "Virtualized-out source-jump succeeds for early, middle, and late
evidence" therefore cannot pass for anything outside the current window.

#### Why this is not a selector fix

There is no longer any DOM anchor that enumerates the conversation, so **N is
unknowable from the DOM** and there is **no scroll target for an absent turn**.
Capture has to become scroll-driven accumulation over the scroll container
itself (scroll to top, walk down by viewport, accumulate ids, stop on scroll
extreme + no-new-ids), and completeness becomes an *estimate* with an explicit
"scroll the whole thread to be sure" state — it can no longer be *proven* from
a skeleton. Storage, the Evidence Invariant, and the trust core are unaffected;
this is contained to `adapters/provider-chatgpt` plus the panel's state
vocabulary. Two cheaper canaries are available immediately and should land
regardless: compare the scroller's `scrollHeight` against the captured span,
and never report `complete` while the scroller is not at both extremes.

## UAT feedback (tester, on the live panel)

### 1. Every card printed its line twice — FIXED

The bold title and the grey preview under it were character-identical. Cause is
presentational: `titleFrom` builds the title as a **prefix of the item's own
evidence quote**, and the panel rendered title *and* the full quote. Short quotes
(most items) rendered identically; long ones showed the same opening words cut
off by a nowrap ellipsis, so the second line never added information either. The
preview now shows only the remainder past the title, is omitted when the title
already is the whole quote, and is clamped to two lines so the tail is readable.
RED-first: both tests failed with "expected 2 to be 1" before the fix.

### 2. Copy should eventually yield summarized notes — DESIGN CONFLICT, not yet actionable

The tester's intent: Copy should produce "very specific summarized notes of that
specific chat item", not the raw sentence it copies today (`item.summary`).

**This collides with the Evidence Invariant as currently written.** `evidence.ts`
requires the displayed title AND summary to be verbatim substrings of an
evidence quote:

```ts
candidate.evidence.some((ev) => ev.quote.includes(candidate.summary))
```

An abstractive summary is by definition not a substring, so it cannot pass this
check — the item would be dropped and counted. Note the README's claim that the
extractor seam is "ready for a neural extractor later, **behind the same
invariant**" does not hold for *abstractive* output: a neural extractor that
still selects spans is fine, one that rewrites is not.

Resolving this is a genuine product decision, not a code change, and it should
be made deliberately because it is the project's central promise:

- **(a) Keep it extractive.** Copy stays verbatim; improve *span selection* so
  the copied sentence is the useful one. Preserves the invariant exactly.
- **(b) Split the fields.** Keep a verbatim `quote` under the invariant, add a
  separate generated `note` that is explicitly labelled as generated and is
  never the thing the invariant vouches for. The trust claim narrows honestly
  from "everything shown is verbatim" to "the evidence is verbatim".
- **(c) Change the invariant** to entailment-checked generation. Much larger
  scope, and it gives up the property that makes the checker cheap and testable.

Recommend (b) if generated notes are wanted soon: it is the only option that
adds the feature without either weakening the invariant or silently breaking the
product's stated guarantee.

### 3. Extraction quality observations (no action yet)

All five "Open questions" on the test conversation were the tester's own
questions to ChatGPT rather than open threads in the discussion. That is the
already-known "role-aware question detection" backlog item (HANDOFF §3), now
confirmed on real data — the rules extractor treats any sentence ending in `?`
as an open question regardless of role or whether it was subsequently answered.
Worth folding into the labeled dataset when that work starts.

## Verdict

**RETHINK CAPTURE — do not proceed to Alpha yet.** Not a kill; the failure is
contained and the expensive parts of the system are vindicated.

What is proven good: the trust core did its job. Of the items that survived,
`0 dropped` and the 7 shown outline items were correct and clickable for the
conversation on screen. Routing, storage, extraction, the Evidence Invariant,
and the panel all behaved. BUG #1 was a lifecycle defect in one adapter and is
fixed with tests. **The problem is not the architecture — it is one falsified
premise about ChatGPT's DOM**, and the provider boundary means it is contained
to `adapters/provider-chatgpt` plus the panel's state vocabulary.

What is not acceptable to ship: a trust-first product that reports `Ready` on an
incomplete capture. The Evidence Invariant guarantees every item *shown* is
grounded — it says nothing about items *missing*, and a confident "Ready" on 86%
of a thread misrepresents that gap. Sound-but-incomplete must be visible.

Ordered next steps:

1. **Land the two cheap canaries first**, ahead of any redesign. (a) Never
   report `complete` unless the scroll container has reached both extremes
   during the pass. (b) Cross-check the scroller's `scrollHeight` against the
   captured span and downgrade to `partial` on a mismatch. Either would have
   turned today's silent `Ready` into an honest `Partial`.
2. **Re-verify the anchor premise on a second long conversation** before
   redesigning, ideally on another account/day, to be sure this is ChatGPT's
   current behavior and not an A/B bucket. Record it as a dated finding the way
   `2026-07-02_chatgpt-virtualization.md` did.
3. **Redesign capture as scroll-driven accumulation** over the scroll container
   (top → bottom by viewport, accumulate ids, terminate on scroll extreme +
   no-new-ids), with completeness as an explicit estimate and a user-visible
   "scroll the thread to complete the index" state.
4. **Rework source-jump** to survive an absent turn wrapper: persist an
   approximate scroll offset (or ordinal position) per record and scroll *there*
   before waiting for the message id to rehydrate.
5. Only then resume the live gate; the M4 usefulness verdict is meaningless
   until capture completeness is sound.

Also worth doing regardless: `AS_OF` in `anchors.ts` still reads `2026-07`, and
the anchor doc comment asserts the wrapper "survives virtualization". Both
should be corrected so the next reader is not misled by a validated-looking
claim that live measurement has falsified.

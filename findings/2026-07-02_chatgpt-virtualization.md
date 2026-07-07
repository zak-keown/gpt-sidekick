# Finding: ChatGPT web now virtualizes the conversation (windowed DOM)

*Date: 2026-07-02 · Pre-M0 empirical check · Chrome 149 · Status: confirmed, needs re-verify on a ≥150-turn chat*

## Why we looked
SPEC §1 names ChatGPT × Chrome as "the highest-confidence starting cell" on two assumptions:
(a) a durable server UUID `data-message-id` in the DOM, and
(b) full history is present in the loaded DOM ("ChatGPT loads full history anyway" — SPEC §2; architecture §4 table: **"Virtualization: none"**).
Before writing product code we captured a real authenticated chat to verify the anchor.

## Method
- Manual DevTools capture → `fixtures.local/chatgpt/2026-07-02_long-150plus.html` (+ `.meta.json`), git-ignored.
- Parsed the DOM (`scratchpad/inspect.py`); ran a `scrollIntoView` hydration probe in the live tab.
- Chat used: ~12 turns / 6 exchanges (NOT a true 150+; re-verify on a long one — see follow-ups).

## What we found
1. **Identity anchor holds (a) ✅** — where a message is rendered, `data-message-id` is a clean server UUID with correct `data-message-author-role`. The trust mechanism (Evidence Invariant) has its anchor.
2. **(b) is FALSE — ChatGPT virtualizes.** Only a moving window of ~5 turns is hydrated (up to **9** simultaneously during active scroll). Off-screen turns are **empty placeholders** (0 chars, no `data-message-id`). Confirmed detach-on-scroll: after a full top→bottom `scrollIntoView` pass, the DOM returned to 5 hydrated / 7 empty. The whole chat is **never in the DOM at once** (thread scroller: sh=20311, ch=863).
3. **New durable per-turn anchor: `data-turn-id`** — a UUID present on *every* turn wrapper, hydrated or not; **survives detach**. Usable as a scroll target and ordering/identity anchor for un-hydrated turns. (Stability across reload not yet verified.)

## Contradicts the planning docs
- architecture §4 table "ChatGPT · Virtualization: none" → **false** (behaves like the doc's Gemini row).
- SPEC §2 deferral of backfill/scroll "because ChatGPT loads full history anyway" → **premise invalid**.
- SPEC §5.2 one-shot `querySelectorAll('[data-message-id]')` would **silently emit a last-window-only outline** with no canary. The missing canary is exactly **turn-count vs message-count** (12 vs 5 here).
- SPEC §11 fixture method ("`capture-fixture` dumps live DOM") → a single `outerHTML` dump now captures only the visible window, not the conversation. A full-conversation fixture must **accumulate normalized events (or stitch per-turn snapshots) across a scroll pass**. Our current fixture `2026-07-02_long-150plus.html` is a **5-turn window, not 150 turns — the filename misleads.**

## Impact on the spike
- ChatGPT is still **best-in-class on identity** (durable UUID; Claude/Gemini have no DOM message id) but is now **hard on capture completeness** (windowed, detach-on-scroll) — the regime the docs reserved for Gemini.
- A one-shot loaded-DOM capture **cannot** satisfy §10.1 (≥99% of nodes) or §10.6 (net-useful on a 150+ chat) for a real long conversation.
- **Not a kill** (provisional on the long-chat window number + capture-before-detach reliability — see follow-ups). Capture change is contained to `adapters/provider-chatgpt`: scroll-through + `MutationObserver`, capture each turn *while hydrated*, idempotent upsert by `[conversationId+messageId]` (SPEC §7 already provides this). The store accumulates the full chat though the DOM never holds it all at once. **`core` / EvidenceChecker / storage schema stay unchanged** — but the **UI is not unchanged**: source-jump becomes async, multi-step and fallible (below) and needs a visible *"re-locating source…"* state. This is not a capture-only change.
- **Source-jump (§5.4):** a detached target is now the *common* case, not the edge. Strategy: jump via the persistent `data-turn-id` placeholder → `scrollIntoView` → re-hydrate → resolve `data-message-id` → highlight.

## Recommendation
Stay on ChatGPT (identity anchor is the load-bearing trust primitive and ChatGPT is uniquely strong there), but **fold a minimal scroll-and-accumulate capture into the spike** rather than deferring it to Alpha. It's an engineering obstacle with a known, contained path — not a reason to cut the success criteria. The "highest-confidence cell" framing keeps its asterisk: highest-confidence on *trust anchor*, no longer on *capture*.

## Open follow-ups
- **[SIZES THE WHOLE DECISION — do first]** Measure the **resting hydrated window on a real ≥150-turn chat** (this test was ~12 turns). Window size is content-dependent (fixed ~863px viewport ÷ turn height): a small window (~5) → incremental capture-while-scrolling is mandatory (Gemini-hard); a large window → scroll-to-top-then-capture nearly works (cheap). Also measure whether the **turn placeholders themselves virtualize** (do all N `data-turn-id` wrappers persist, or only a window?) — that decides whether we even have a full skeleton/ordering without scrolling.
- Confirm **capture-before-detach** is reliable on a long chat (turns detaching faster than we capture would move "not a kill" back toward the §1 kill criterion, which is explicitly about *long* conversations).
- Verify `data-turn-id` stability across page reload (is it server-backed? — decides its use as a persistent source-jump anchor).
- Then decide (user fork): fold capture-completeness into the spike, or rescope the spike's success criteria. **Lean: stay on ChatGPT** — its durable UUID is the *verified* trust primitive; a cell-switch to Claude trades that for an *unverified* no-virtualization claim (docs never live-inspected Claude, §4 provenance) plus Claude's *known* identity weakness. Not co-equal.

## Update — 74-turn chat measured (2026-07-02)
Second probe on a longer (74-turn) chat, grown live in-session:
- **AT LOAD: 62/74 hydrated** — an **in-session artifact**: freshly-rendered content stays in the DOM until the virtualizer evicts on scroll-away. A cold open of an existing long chat would not show this (reload confirmation still pending — optional).
- **RESTING window collapsed to 5** after a scroll pass (same ~5 as the 12-turn chat) → **window size is ~5 turns and does NOT scale with conversation length.** `MAX 63` during the pass is the pre-eviction leftover, not scroll accumulation.
- **`placeholders virtualized: NO` — all 74 `data-turn-id` wrappers persist.** Full skeleton always available: exact length, ordering, stable per-turn scroll target. **This is NOT Gemini's hardest case.**
- ⇒ Full capture is a **bounded, deterministic** loop over the known turn-ids (scrollIntoView → hydrate → capture → upsert). Capture-before-detach is not a race when capturing synchronously per centered/hydrated turn.

**SPEC contradiction this exposes (the user fork):** §10.6 requires proving the outline is net-useful on a 150+ chat, but §2 deferred the scroll-capture needed for that to Alpha on the now-false "ChatGPT loads full history" premise. The spike cannot stay one-shot *and* satisfy §10.6. → **(A)** fold bounded scroll-capture into the spike [recommended — honors §10.6], or **(B)** keep a window-only spike and formally defer full capture + rescope §10.6.

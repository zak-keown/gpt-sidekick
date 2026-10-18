# Authenticated ChatGPT validation, 2026-10-18

Environment: Chrome for Testing 156.0.8078.4 on macOS, installed unpacked from
this repository's `dist` directory. The actual Chrome side panel was used.
The user supplied a signed-in conversation. No transcript or financial content
is included in this record.

## Initial result

The side panel opened and resolved the correct active conversation. Capture
reported zero turns despite visible messages. Developer Tools confirmed that
`data-turn-id`, `data-message-id`, and `data-message-author-role` were all absent.
The synthetic legacy-layout browser journey did not cover this version of the
site. It must not be treated as evidence of current live-site compatibility.

## Observed current DOM contract

- Mounted turns: `[data-turn-key]`. These elements disappear outside the rendered
  window; they are not a persistent skeleton for the complete history.
- User content: `[data-user-message-bubble]`, inside a search unit with
  `data-chatgpt-search-message-ids` and a role-qualified search-unit key.
- Assistant content: `[data-chatgpt-selection-message-id]`, paired with
  `data-chatgpt-selection-conversation-id`. Its content root has
  `data-markdown-text-style="assistant-message"`.
- A search unit can repeat the same UUID in its space-separated message-ID
  attribute. Repetition must be deduplicated; different IDs are ambiguous.
- Assistant role headings have `data-conversation-role="assistant"` and are
  separate from the actual message content.
- Timeline scroller: `[data-app-action-timeline-scroll]`. Scrolling to the top
  can prepend earlier history and move `scrollTop` through scroll anchoring.
- The virtualized range uses a height placeholder and an offset rendered-window
  child. Counts of mounted turn elements are not total conversation counts.
- The page exposes a screen-reader “Loading older messages” label. Its presence
  alone does not establish a complete history boundary.

During inspection, the mounted window varied between five and seven turns while
scrolling loaded earlier messages and substantially increased the scroll range.

## Remediation and observed results

Support both DOM layouts while retaining exact message identity, conversation
checks, canonical evidence validation, and explicit partial coverage. Add
synthetic fixtures based on these structural attributes, never personal text.

The adapter now supports both layouts. A second live issue was found and fixed:
inherited `white-space: pre-line` inside assistant widgets must preserve text
whitespace without suppressing structural paragraph boundaries. Before that fix,
assistant responses collapsed into run-on lines and useful candidates were missed.

After rebuilding and reloading the extension, the actual side panel showed five
of five mounted turns captured and seven extractive items. It correctly retained
the partial-history status. These are mounted-window counts, not total history.

| Check | Live result |
| --- | --- |
| Actual Chrome side panel opens | Passed |
| Active conversation identity | Passed |
| Current-layout mounted capture | Passed, five mounted turns |
| User-message exact source navigation | Passed |
| Assistant-message exact source navigation | Passed |
| Reindexing preserves conversation reading position | Passed by before/after visual comparison |
| Switching to an unsupported tab clears the outline | Passed |
| Complete conversation coverage | Not established; explicitly partial |
| Recovery of sources outside the mounted window | Not established; still requires new virtualizer support |
| Live streaming convergence | Not tested in this existing completed conversation |
| Live service-worker restart | Not tested; automated lifecycle coverage only |

The browser regression suite now exercises both layouts against synthetic content.
Those fixtures contain no personal conversation text. The original legacy-only
suite passed while the new-layout regression failed; both pass with the fix.

## Initial verdict

The current-layout mounted capture/source loop works on the supplied conversation.
The full live-release gate remains open. The new virtualizer needs a bounded
history traversal and source-recovery design that handles window replacement,
prepending, and scroll anchoring. Rules extraction also needs usefulness review:
the seven current items were questions, including assistant section headings and
an embedded draft, rather than a demonstrated useful decision/action outline.

## Follow-up implementation and checks

The windowed adapter now loads older history to a stable top boundary before
sweeping down through replacing windows. It waits for loading indicators and
scroll anchoring to settle. Completion requires stable top and bottom boundaries,
contiguous unique turn positions, stable message identities, and no streaming.
Traversal is bounded to 45 seconds or 2,000 samples; source timeline search to
20 seconds, followed by a brief bounded hydration wait when needed.
Scroll hints accelerate lookup but never establish identity or bypass exact-text
validation. Failed lookups restore the original reading position.

The first live traversal discovered 27 turns and conservatively reported 26 as
complete. Structural DOM inspection identified one terminal `cancelled` turn
containing a user message and no assistant message. The adapter now recognizes
that state as terminal when its available content has stable identity. A provider
regression covers this case.

Extraction now treats assistant questions conservatively and recognizes explicit
recommendations and imperative next steps as quoted actions. User clarification
markers produce corrections. The live outline contained actions and corrections
as well as questions; generic section headings and the previously observed
embedded draft question were omitted. These are rule-based classifications, not
a semantic summary or a guarantee that later messages supersede earlier ones.

Automated verification: 69 unit tests, production build, and three Chromium
extension journeys passed. The third journey starts with four loaded turns,
prepends older history asynchronously, replaces off-screen windows, verifies all
nine synthetic turns, restores the bottom reading position, and recovers an
unmounted exact assistant source. Test fixtures contain no personal content.

## Final follow-up live results

| Check | Result |
| --- | --- |
| Full windowed-history traversal | Passed: 27 of 27 discovered turns, “Outline up to date” |
| Bottom reading-position restoration | Passed: measured bottom gap zero after traversal |
| Early user source outside mounted window | Passed: absent at bottom, recovered and remounted at turn position zero |
| Early assistant source outside mounted window | Passed after bounded hydration settling; also passed after extension/conversation reload |
| Saved evidence drift | Rejected rather than highlighting a different revision |
| Panel lookup failure persistence | Unit regression passed; polling retains the outline and dismissible error |
| Limited scan after a history prepend | Provider regression passed; the unmounted reading position accounts for the added history |
| Live streaming convergence | Still not tested in this completed conversation |
| Explicit live service-worker stop/restart | Still not tested; extension reload and saved-source recovery passed |

The assistant-source test initially rejected a remounted message whose content
had not yet settled. The provider now retries exact canonical-text matching for
a bounded period before reporting a changed source. It still requires the same
message UUID, role, conversation, and full canonical text. A delayed-hydration
regression passes, and permanent text drift remains rejected.

These results establish compatibility with this observed conversation and DOM
version. They do not prove coverage of every ChatGPT layout, branch behavior,
or future site change. No private transcript text was saved as a fixture.

## Streaming and worker lifecycle follow-up

A modern-layout gap was found: a verified sweep that ended during streaming
could remain partial after the response finished. History coverage now persists
separately from completion. Each unfinished turn stays pending until its mounted
content exposes a recognized terminal status and valid message identity. Losing
an unfinished turn from the mounted window does not count as completion.
Regeneration withdraws readiness, and changed turn identities or positions
invalidate coverage. The position attribute is now observed directly.

When a verified streaming sweep later becomes complete, its first ready batch
replaces obsolete saved history. Subsequent passive updates accumulate normally.
The panel distinguishes pending content after traversal from mounted-only
coverage, and the reindex acknowledgment no longer keeps saying it is reading
after indexing has finished.

The production-extension lifecycle journey passed with real Chromium worker
termination, not an extension or page reload as a substitute. It verifies:

- Streaming text is replaced by the completed response without another reindex.
- A position-only DOM mutation invalidates coverage.
- The worker reports stopped and its browser target disappears.
- Reopening the panel reads committed data before any new page mutation.
- The restarted worker has a fresh JavaScript global, then accepts capture from
  the existing content script. Chromium reuses its logical target ID, and
  Playwright does not emit a worker-close event at this stop/start boundary.
- Deletion remains paused across another worker stop and a fresh content script
  after page reload, until explicit reindexing.

Final automated result: 72 unit tests, type checking, production build, and all
four browser journeys passed.

Clean authenticated streaming validation remains open. During the live attempt,
a synthetic checklist prompt was accidentally submitted to the existing test
conversation rather than a separate chat. Its response was stopped with explicit
user approval. The synthetic message remains in that conversation; this attempt
is not counted as a clean live streaming pass. No private content was added to
repository fixtures. An explicit worker stop in the authenticated profile also
remains untested; the isolated lifecycle test above establishes the browser
mechanism and persistence behavior with synthetic content.

## Extraction and two-window follow-up

The authored extraction regression set contains three synthetic conversations
and 24 expected items. The baseline missed six and added five unwanted items;
the revised rules match the answer keys without extra items and retain exact
source evidence. This is not a real-user usefulness measurement or a held-out
benchmark. Details and reproduction commands are in
[the evaluation record](extraction-evaluation-2026-10-18.md).

A fifth isolated production-extension journey verifies two distinct Chrome
windows in the same profile. Each extension-page panel resolves its own window,
shows only that window's active conversation, and sends source commands to the
matching page. It specifically checks an unfocused panel while another window
is reported focused. Unsupported-tab switches clear only the corresponding
panel, and source navigation still targets the right page after switching back.

Chrome-created fixture tabs start blank and navigate only after the test harness
attaches, ensuring their synthetic ChatGPT requests are intercepted. Native
side-panel docking is not represented by these extension-page surrogates. The
headless build did not reflect requested OS focus transitions reliably, so a
focus-change pass is not claimed. Native two-window focus transitions remain a
live check.

Verification for this follow-up: type checking, production build, all 78 unit
tests, the 24-item evaluation, and all five browser journeys passed. Every test
used authored content in temporary profiles. The user's existing conversation
was not opened or modified during this follow-up. The existing authenticated
streaming and worker-stop gates remain open, as does real-user usefulness
assessment on additional representative conversations.

## User-controlled indexing cancellation

The panel now provides a pinned **Stop indexing** control during active capture. It retains saved
sources and the scan's last known progress checkpoint, restores the reading
position, and reports partial coverage. Passive message capture continues, with
the stopped status retained until a fresh reindex or conversation navigation.
Copying, filtering, and deletion stay available; another reindex and source
jumps are disabled while the scan is active.

Cancellation is a separate content command. It invalidates queued and running
scan generations without clearing the transcript or the deletion pause. The
background sends it only to the authorized active tab in the panel's window and
rejects attempts to cancel another tab's capture ownership. Its final partial
batch uses the current run with a higher sequence; delayed older batches cannot
overwrite it. A late cancellation refreshes the provider's current state while
preserving completed coverage. If the worker lost the original completion
delivery, this refresh sends the verified full transcript again instead of
leaving the panel stuck in its older capturing state.

Unit regressions cover queued cancellation, retained sources and progress,
restoration, immediate handoff to a newer scan, idle cancellation, ownership,
sequence gaps, and deletion-pause preservation. The production-extension browser
test blocks a pending history load, stops indexing, checks retention and reading
position, then releases the exact blocked load. It observes capture traffic and
checks that the cancelled run emits neither further progress nor readiness. A
new scan then captures all nine synthetic turns successfully. A narrow 360px-wide
panel is scrolled to the end of its long outline during capture; the test checks
that the pinned Stop control remains inside the viewport.

Verification: type checking, production build, all 85 unit tests, all six browser
journeys, and the 24-item synthetic extraction evaluation passed. This follow-up
used temporary browser profiles and synthetic content only. Existing live gates
for clean authenticated lifecycle checks, native focus transitions, and real-user
outline usefulness remain open.

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

## Verdict

The current-layout mounted capture/source loop works on the supplied conversation.
The full live-release gate remains open. The new virtualizer needs a bounded
history traversal and source-recovery design that handles window replacement,
prepending, and scroll anchoring. Rules extraction also needs usefulness review:
the seven current items were questions, including assistant section headings and
an embedded draft, rather than a demonstrated useful decision/action outline.

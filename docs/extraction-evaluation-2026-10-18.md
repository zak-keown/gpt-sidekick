# Synthetic outline evaluation, 2026-10-18

This is a regression corpus, not a held-out benchmark or a measure of real-user
usefulness. The rule changes were informed by these cases. Perfect matches on
this small authored set do not imply general extraction accuracy.

The corpus contains three synthetic conversations, twelve messages, and 24
expected items across decisions, actions, questions, artifacts, code, corrections,
and notes. None of its text comes from a user's conversation. Each answer key
names the exact message, category, and source quotation. Extra extracted items
are counted as false positives; omitted expected items are counted as misses.
The runner independently checks evidence offsets and titles against their source.

## Measured results

| Scenario | Expected | Baseline matched | Baseline extra | Current matched | Current extra |
| --- | ---: | ---: | ---: | ---: | ---: |
| Software planning | 7 | 6 | 3 | 7 | 0 |
| Research comparison | 8 | 6 | 1 | 8 | 0 |
| Troubleshooting | 9 | 6 | 1 | 9 | 0 |
| Total | 24 | 18 | 5 | 24 | 0 |

The baseline had six misses and five false positives. Both versions returned
valid source evidence for the items they did extract. The changes address:

- Recommendation headings such as “Where I would start” were listed as actions.
  Recommendations now require a clause boundary, retaining sentences such as
  “For this release, I would prioritize deletion controls.”
- Explicit follow-ups such as “One more question:” and “One last important
  question:” were omitted. Their introductions are now recognized.
- A hypothetical or explicitly labeled example could be classified as a decision.
  Clear conditional introductions, explicit draft/example/quotation markers, and
  questions about whether a decision was made no longer establish commitments.
- Explicit assistant `Note:` statements and named `.log` artifacts were missed.
  Explicit notes now work for either conversational role; `.log` and `.txt` files
  are recognized artifacts when accompanied by an artifact/file marker.

Historical decisions remain extracted events after later corrections. The
extractor does not infer supersession or present a final-state summary. It can
still miss unmarked recommendations, more varied follow-up phrasing, and the
meaning of unmarked quoted or drafted prose. In particular, an unpunctuated
preamble before a recommendation can be omitted by the conservative rule.

## Reproduce

```sh
npm run evaluate
npm test -- tests/extraction-evaluation.test.ts tests/extraction-quality.test.ts
```

The CLI exits nonzero for misses, extra items, or invalid evidence. Its scenarios
and answer keys are in `evaluation/conversations.ts`. New regression cases should
describe expected user-facing behavior before changing the rules. Evaluation on
three representative real conversations, with user assessment, remains open.

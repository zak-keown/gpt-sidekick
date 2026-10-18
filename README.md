# GPT Sidekick

A local Chrome companion for long ChatGPT conversations. Find decisions, actions,
questions, artifacts, code, and corrections, then jump back to the exact message
behind each item.

This is a fresh implementation on `restart/fresh-implementation`. The original
spike is preserved on `main`; historical plans are in [docs/reference](docs/reference).
See [RESTART.md](RESTART.md) for the delivery approach.

## Run it

Requires Node 22.12 or newer and Chrome 116 or newer.

```sh
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select this repository's `dist` directory. Open or reload a saved conversation on
`chatgpt.com`, then click the extension action to open Sidekick.

Passive capture reads visible messages without scrolling. **Reindex conversation**
runs a bounded scroll through available turns and restores the previous scroll
position. Missing, changing, or unavailable turns produce a partial outline.
Full indexing checks up to 2,000 turns (or scroll samples for a windowed timeline)
or 45 seconds; reaching either limit is
reported as partial. It never claims access to unavailable history.

When a sweep verifies history while an identified response is still streaming,
Sidekick waits for that turn to finish and updates the outline without another
full scan. An unfinished turn stays pending even while it is off-screen.
New turn identities or changed ordering require a new history check.

ChatGPT currently serves more than one page layout. The newer windowed timeline
uses different message attributes and can prepend older history while removing
off-screen turns. Reindex first loads the older-history boundary, then sweeps
the timeline and collects stable message UUIDs. Coverage is complete only when
both boundaries and a contiguous turn sequence have been verified. Passive
capture alone remains partial. See the
[live validation record](docs/live-validation-2026-10-18.md) for observed limits.

For a UI preview with explicitly labeled sample data:

```sh
npm run dev
# Open http://127.0.0.1:5173/sidepanel.html?demo
```

## Trust and privacy

Every item has an exact quotation and offsets into a captured message. The core
checks `message.text.slice(start, end) === quote`, and the title must be a substring
of that quotation. Source navigation checks the live message against the saved
canonical text before highlighting it. An unmounted source is located using a
scroll hint followed by a bounded timeline search, up to 20 seconds, and a brief
wait for remounted content to hydrate. Failed
lookups restore the previous reading position. Edited or unavailable sources produce
an error rather than highlighting a different message.

Extraction uses deterministic rules; it does not paraphrase or call a model. It
can miss decisions and does not infer whether later messages supersede them.
Questions from assistant messages require conversational follow-up wording;
generic section-heading questions are omitted.

Snapshots live in the extension's IndexedDB. The extension makes no network
requests. Delete controls remove stored messages and outlines and pause capture
until explicitly resumed with Reindex. Deleting one conversation retains minimal
capture-order/deletion metadata to reject queued messages. Deleting all data also
removes that metadata, retaining only a global pause preference. There is no sync,
telemetry, or provider backend access.

When the same conversation is open in multiple tabs, one tab owns capture.
Reindex explicitly transfers capture to the current tab. Other tabs show a prompt
to reindex rather than an outline from a potentially different message revision.

## Development

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run e2e
```

The browser test loads the production extension into Chromium against synthetic
ChatGPT-shaped pages. It checks capture, full indexing, evidence navigation,
saved-state reload, tab isolation, deletion, and explicit capture resumption.
A virtualized fixture also checks delayed history prepending, reading-position
restoration, and recovery of an unmounted source.
The lifecycle journey verifies streaming completion, actual service-worker
termination and restart, saved-state reads before new capture, continued capture
from the existing page, and durable deletion pause after a page reload.
These checks do not establish compatibility with authenticated ChatGPT's current
DOM or long-conversation virtualizer.

```text
src/core          Pure types, extraction, evidence checks, snapshots
src/provider      ChatGPT DOM capture, bounded hydration, source navigation
src/background    Authorization, capture ordering, IndexedDB persistence
src/panel         Preact side panel and explicit sample-data preview
src/content.ts    Content-script entrypoint
src/background.ts Service-worker entrypoint
tests             Trust, lifecycle, storage, provider, and UI tests
e2e               Built-extension browser journey
```

## Next release gate

Completed-thread validation on the supplied authenticated conversation covered
27 turns, reading-position restoration, and off-screen user and assistant source
navigation. Clean live streaming validation and an explicit worker restart in
the authenticated profile remain open. The isolated production-extension suite
covers those lifecycle paths with synthetic content.

Measure outline usefulness on three representative conversations before extending
extraction or provider support. Keep real fixtures under the ignored
`fixtures.local/` directory. Do not commit private transcript data.

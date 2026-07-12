# GPT-Sidekick

A Chrome extension that gives you a **live, source-linked outline** of long ChatGPT
conversations — so a thread that has scrolled past readability becomes navigable at
a glance, and every outline item links back to the exact message it came from.

> **Status:** working spike (ChatGPT × Chrome). The trust core, storage,
> targeted messaging, explicit re-index, grouped outline UI, copy controls, and
> source-jump are built and tested. The remaining spike gate is a manual
> virtualized load-test on live chatgpt.com conversations — see
> [`HANDOFF.md`](./HANDOFF.md).

## Why it's different: the Evidence Invariant

The whole point of a summary you can trust is that it can't quietly make things up.
GPT-Sidekick enforces one rule, everywhere, in code:

> **No outline item may exist without a link to the exact source message, where the
> item's quote is a verbatim substring of that message's canonical text.**

Concretely, for every surviving outline item and each piece of its evidence,
`record.text.slice(offsetStart, offsetEnd) === quote` must hold exactly, and the
displayed title/summary must be grounded in an evidence quote. Anything that fails
is **dropped and counted**, never shown. This is tested with property + revert-
sensitive tests: weakening the check (e.g. exact-substring → `includes`) turns a
green fixture red. The extractor is deliberately **rules-based and extractive** (no
rewriting) for the spike — a drop-in `Extractor` seam is ready for a neural
extractor later, behind the same invariant.

## How it works

```
ChatGPT tab (content script)          Service worker (owns the store)      Side panel
─────────────────────────────         ──────────────────────────────      ──────────
capture() over the persistent   ──►   §13 targeted router ──► store   ◄──  routed RPC:
[data-turn-id] skeleton, reading      (attested source,      upsert →       subscribe +
durable data-message-id UUIDs;        cross-tab firewall)    extract →      fetch outline;
passive scroll-accumulate.                                   Evidence       renders the
                                                             Invariant →    live outline.
                                                             persist (Dexie)
```

- **Capture** walks ChatGPT's virtualized DOM: a persistent `[data-turn-id]`
  skeleton (all turns) with only a ~windowed few hydrated at once. It keys on the
  durable `data-message-id` UUID and accumulates as you scroll. Fails *closed* and
  *loud* on selector rot rather than emitting polluted text.
- **Routing** is targeted, not broadcast: a transcript payload from tab A reaches
  only tab A's panel. Source identity is Chrome-attested; a cross-tab firewall and
  per-caller read authorization enforce tenant isolation (§13).
- **Storage** is local-first IndexedDB (Dexie), owned by the service worker so
  captures survive the panel closing. Outlines are written under a
  compare-and-swap so a stale index can't clobber a fresher one.

Nothing leaves your machine.

## Repo layout (pnpm + Turborepo monorepo)

```
packages/core                     DOM/host-free trust core (no dependencies):
  protocol.ts   correlation-id RPC          router.ts    §13 attested/firewalled routing
  model.ts      §4 data model               evidence.ts  the Evidence Invariant checker
  extractor.ts  rules extractor + seam      store.ts     TranscriptStore + in-memory impl
  pipeline.ts   records → outline           service.ts   the store-service RPC contract
packages/adapters
  provider-chatgpt   ChatGPT DOM → TranscriptEvent[] (anchors, canonicalize, capture, hydrate)
  storage-dexie      TranscriptStore over IndexedDB
  host-chrome        chrome.runtime transport, SW port router, routed RPC
packages/ui          Preact side-panel components (OutlinePanel)
apps/chrome-spike    the WXT MV3 extension wiring it all together
```

Package boundaries are lint-enforced: **`core` imports nothing** (stays DOM- and
host-free, so the trust rules are provider-agnostic); adapters/ui may import
`core`; the app composes everything.

## Getting started

```bash
pnpm install
pnpm test          # 125 unit/integration/component tests (Vitest)
pnpm build         # builds all packages + the extension → apps/chrome-spike/.output/chrome-mv3
pnpm typecheck     # strict tsc across the workspace
pnpm lint          # eslint + package-boundary rules
pnpm --filter chrome-spike e2e   # Playwright: SW smoke + capture → panel → source-jump
```

**Load the extension** (Chrome/Chromium):

1. `pnpm build`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `apps/chrome-spike/.output/chrome-mv3`
3. Open a `chatgpt.com` conversation, open the GPT-Sidekick side panel, and scroll.

See [`HANDOFF.md`](./HANDOFF.md) for the load-test checklist and what to look for.

## Development discipline

RED-first TDD with revert-sensitivity checks (break the fix, confirm the specific
test reds, restore), adversarial review at each milestone boundary, and scrupulous
"proven vs assumed/gated" honesty in the plans. Real ChatGPT DOM captures used for
anchor validation are personal data and live only in `fixtures.local/`
(git-ignored) — never committed.

## Docs

- [`SPEC.md`](./SPEC.md) — the product/engineering spec
- [`plans/`](./plans) — per-milestone plans (M0 skeleton, M1 capture, M2 core+evidence) with deferred-item tracking
- [`HANDOFF.md`](./HANDOFF.md) — current status, the next action, and the watch-list

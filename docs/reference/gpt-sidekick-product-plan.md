# GPT-Sidekick Product Plan

GPT-Sidekick is a sidecar memory layer for long AI conversations. It turns a sprawling chat into a live, source-linked outline of decisions, open questions, artifacts, code snippets, and next actions, so users can recover the thread without rereading the whole exchange.

> **Engineering companion:** [`gpt-sidekick-architecture-and-research.md`](./gpt-sidekick-architecture-and-research.md) holds the research-backed architecture, the Python-free stack, the per-surface capability/pitfall matrix, and the features-per-surface breakdown (researched 2026-07-01). This document is the product thesis; that one is the build plan.

## Core Thesis

The product should not be framed as a generic table of contents. The sharper pain is that users lose the thread in long-running AI work. GPT-Sidekick should help them answer:

- What did we decide?
- What facts or assumptions were established?
- What questions are still open?
- What artifacts were produced?
- Where did the assistant correct itself or change direction?
- What should I do next?

The trust mechanism is source-linking. Every outline item should jump back to the exact message or artifact that supports it.

## Feasibility

A browser extension can function for this, but there are real limits:

- It can reliably index what is currently loaded in the page.
- It can reliably capture new messages from the moment the extension is active.
- It can attempt best-effort backfill by scrolling/loading old messages, but this is slow and brittle.
- It should not promise complete retroactive access unless a provider offers a reliable API, export, or integration path.

The defensible product claim is:

> GPT-Sidekick builds a live, source-linked outline of long conversations as they happen, and can attempt best-effort backfill for already-loaded history.

## Architecture

Build one headless core with thin adapters, not separate products per provider.

```text
GPT-Sidekick Core
  transcript model
  incremental indexer
  outline extraction
  local storage
  privacy/redaction rules
  source-linking model

Provider Adapters
  ChatGPT web
  Claude web
  Gemini web
  Cursor/Copilot/etc. later
  transcript import/export

Host Adapters
  Chrome extension
  Firefox extension
  Safari extension
  VS Code extension
  JetBrains plugin
  CLI/coding-agent integration
```

The core should receive normalized events and should not know which host or provider produced them.

```ts
type TranscriptEvent = {
  provider: string;
  conversationId: string;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  anchor: {
    kind: "dom" | "file" | "transcript";
    locator: string;
  };
};
```

Each adapter has the same job:

- Capture messages.
- Normalize them into core events.
- Render the shared outline UI.
- Jump back to the source anchor.

## Provider Capability Model

Represent support honestly per provider.

```ts
type ProviderCapabilities = {
  liveCapture: boolean;
  readLoadedHistory: boolean;
  bestEffortBackfill: boolean;
  fullServerHistory: boolean;
  stableMessageIds: "yes" | "partial" | "no";
  sourceJump: boolean;
};
```

For most web chat providers, `fullServerHistory` should be false unless there is a sanctioned API or export path.

Researched values (2026-07-01 — see the companion doc for anchors, pitfalls, and confidence):

| Capability | ChatGPT | Claude | Gemini |
|---|---|---|---|
| `liveCapture` | ✅ | ✅ | ✅ (re-resolve nodes) |
| `readLoadedHistory` | ✅ strong | ✅ full | ⚠️ rendered-only |
| `bestEffortBackfill` | ~N/A (all loaded) | ~N/A (all loaded) | ⚠️ required & lossy |
| `fullServerHistory` | export only | export only | export only (Takeout → My Activity → Gemini Apps) |
| `stableMessageIds` | `yes` (`data-message-id` UUID) | `partial` (DOM no / JSON `uuid`) | `partial` (conv id yes / msg no) |
| `sourceJump` | ✅ | ⚠️ hash+ordinal | ⚠️ windowing + weak id |

Note: for all three web providers `fullServerHistory` is **export-only** (sanctioned, batch, point-in-time) — never a live signal. Scripting backend endpoints violates provider terms (Anthropic enforced Jan 2026).

## Evidence Rule

No evidence, no outline item.

```ts
type OutlineItem = {
  type: "decision" | "action" | "question" | "artifact" | "code" | "correction" | "note";
  title: string;
  summary: string;
  evidence: Array<{
    messageId: string;
    quote: string;
    offsetStart?: number;
  }>;
};
```

This protects user trust. If the model cannot point to the original message, it should not present the item as established.

## Incremental Processing

Avoid resummarizing the whole conversation on every update.

Use a rolling model:

- Raw messages become stable transcript records.
- Transcript records are grouped into segments.
- Segments produce outline candidates.
- Candidates merge into a thread-level outline.
- New messages only process the tail plus a small context window.

## MVP

Start narrow:

> GPT-Sidekick for ChatGPT in Chrome: live outline, local-first, source-linked, with best-effort backfill.

Initial features:

- Chrome side panel UI.
- ChatGPT web content script.
- Capture loaded conversation DOM.
- Watch new messages with mutation observation.
- Local storage by default.
- Outline categories: Decision, Action, Question, Artifact, Code, Correction.
- Source jump for every item.
- Copyable artifacts such as checklist, JSON, decision text, and code blocks.
- Explicit indexing state: live, indexing, partial, failed.

Avoid in v1:

- Multi-provider support.
- Multi-browser support.
- Team sync.
- Full historical import promises.
- Cloud upload by default.

## Product Sequence

1. Spike Chrome + ChatGPT + local storage + outline from loaded DOM.
2. Alpha live capture, source jump, copyable decisions/checklists/code, best-effort backfill.
3. Hardening with parser fixtures, Playwright checks, and privacy review.
4. Add a second provider, likely Claude web, to prove the adapter boundary.
5. Add a second browser, likely Firefox, to prove host portability.
6. Add a coding surface, likely VS Code, using the same core with a different capture adapter.
7. Add optional sync/team features only after local-first value is proven.

## Coding-Agent Surface

Treat coding tools as a second product surface, not the initial launch.

The same core model can work, but capture differs:

- IDE chats
- terminal sessions
- local agent transcripts
- file artifacts
- diffs and commits
- task plans and decisions

VS Code is likely the first coding host because its extension model supports sidebar/webview UI. JetBrains can follow with a tool window integration.

**Research refinement (2026-07-01):** the strongest first *capture* path is not IDE chat — VS Code's public API provably **cannot read another extension's chat** (Copilot included) — but **tailing the append-only JSONL transcripts coding agents already write to disk** (Claude Code `~/.claude/projects/**/*.jsonl`, Codex CLI `~/.codex/sessions/**/*.jsonl`), which map 1:1 onto the core's event model and let `core` run as plain Node with zero port cost. VS Code then becomes a **UI-delivery** surface (plus stable terminal/git *signals*), not the capture engine. See the companion doc §6.

## Privacy Posture

Privacy should be a product feature:

- Local-first by default.
- Per-site permissions.
- Obvious indexing indicator.
- Delete-thread control.
- Optional user-supplied model key.
- Optional cloud sync later.
- No silent upload of conversation content.

## Main Risks

- Provider DOM changes can break capture.
- Long/old conversations may not fully load in the DOM.
- Browser extension permissions may scare users.
- AI summaries can hallucinate unless every item is evidence-linked.
- Native chat products may eventually add similar outlines.

The wedge should be power-user trust and workflow depth, not generic summarization.

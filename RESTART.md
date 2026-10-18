# Fresh implementation

The implementation on `main` is the reference spike. Work on
`restart/fresh-implementation` is a new implementation of the same product.

## First milestone

Chrome extension for ChatGPT: local conversation capture, an extractive outline
with exact source evidence, and navigation back to the cited message.

## Architecture

One TypeScript application with explicit module boundaries. `src/core` is pure
TypeScript; `src/provider` owns ChatGPT DOM interaction; `src/background` owns
persistence and authorization; `src/panel` owns presentation. No cloud calls,
provider backend scraping, or runtime dependencies in core.

The service worker owns storage. Each panel binds to its own browser window and
follows that window's active tab. Content messages derive identity from Chrome's
sender metadata. Capture and progress survive panel closure; saved snapshots
survive service-worker restarts. Missing or virtualized messages are reported.

## Delivery

The lead owns contracts, core, reviews, integration, and release checks.
Developer agents own provider capture, panel UI, and extension integration.
Each workstream adds meaningful tests for its trust and lifecycle boundaries.
The original spike's implementation is not copied into the new source tree.

Automated checks do not establish compatibility with today's authenticated
ChatGPT DOM. Live long-conversation validation remains an explicit release gate.

## Integration decisions

- Fresh single-app build replaces the spike's monorepo orchestration. TypeScript,
  Preact, Vite, and a small extension bundler are sufficient for this milestone.
- Capture never calls provider backend endpoints. Visible messages accumulate;
  explicit full indexing traverses a bounded set of timeline windows, checking
  history boundaries, message identities, and turn ordering.
- Same-conversation tabs require explicit Reindex to transfer capture ownership.
  The panel does not display another tab's potentially different message revision.
- IndexedDB commits snapshot/capture order together, and deletion/pause policy
  together. Queued messages cannot undo a completed deletion.
- Rules extraction remains intentionally extractive. Source fidelity is tested;
  outline usefulness needs real conversations and user evaluation.

## Next work

1. Finish clean authenticated streaming and worker-restart validation. Completed
   long-thread traversal and off-screen source recovery passed; the isolated
   production-extension suite now also verifies actual worker termination and
   streaming convergence.
2. Measure outline usefulness on three representative conversations before adding
   a neural extractor or more provider adapters.
3. Use observed failures to assign the next bounded developer tasks. Treat the
   archived specs as historical evidence, not requirements that override the
   current product goal or measured behavior.

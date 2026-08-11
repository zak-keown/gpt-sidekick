import { useEffect, useRef, useState } from "preact/hooks";
import type { Rpc } from "@gpt-sidekick/core/protocol";
import type { OutlineItem, OutlineType } from "@gpt-sidekick/core/model";
import {
  fetchConversationId,
  fetchIndexState,
  fetchOutline,
  onIndexStateChanged,
  onJumpResult,
  onOutlineChanged,
  requestReindex,
  requestSourceJump,
  type IndexingState,
} from "@gpt-sidekick/core/service";
import * as styles from "./OutlinePanel.css";

const GROUPS: ReadonlyArray<{ type: OutlineType; label: string }> = [
  { type: "decision", label: "Decisions" },
  { type: "action", label: "Actions" },
  { type: "question", label: "Open questions" },
  { type: "artifact", label: "Artifacts" },
  { type: "code", label: "Code" },
  { type: "correction", label: "Corrections" },
  { type: "note", label: "Notes" },
];

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatIndexState(state: IndexingState): string {
  switch (state.kind) {
    case "idle":
      return "Idle";
    case "capturing":
      return `Capturing · ${state.processed}/${state.expected} turns · ${plural(state.unstable, "unstable")}`;
    case "indexing":
      return `Indexing · ${state.captured}/${state.expected} turns · ${plural(state.unstable, "unstable")}`;
    case "ready":
      return `Ready · ${plural(state.messages, "message")} · ${plural(state.items, "item")} · ${state.droppedNoEvidence} dropped`;
    case "partial":
      return `Partial · ${state.captured}/${state.expected} turns · ${plural(state.messages, "message")} · ${plural(state.items, "item")} · ${plural(state.unstable, "unstable")}`;
    case "failed":
      return `Failed · ${state.reason}`;
  }
}

export function OutlinePanel({ rpc }: { rpc: Rpc }) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [indexState, setIndexState] = useState<IndexingState>({ kind: "idle" });
  const [jumpState, setJumpState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeJump = useRef<string | null>(null);
  const earlyJumpResults = useRef(new Map<string, "found" | "not-found">());

  useEffect(() => {
    let alive = true;
    const fail = (e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    };
    const load = async (nextConversationId: string | null) => {
      if (!alive) return;
      setConnected(true);
      setConversationId(nextConversationId);
      if (!nextConversationId) return;
      try {
        const outline = await fetchOutline(rpc, nextConversationId);
        if (alive) setItems(outline);
      } catch (e) {
        fail(e);
      }
    };

    // Subscribe before initial reads so no capture or jump completion is lost.
    onOutlineChanged(rpc, (nextConversationId) => void load(nextConversationId));
    onIndexStateChanged(rpc, (state) => {
      if (alive) setIndexState(state);
    });
    onJumpResult(rpc, (result) => {
      if (!alive) return;
      if (result.requestId !== activeJump.current) {
        earlyJumpResults.current.set(result.requestId, result.status);
        return;
      }
      activeJump.current = null;
      setJumpState(
        result.status === "found" ? "Source highlighted." : "Source not on screen.",
      );
    });

    void Promise.all([fetchConversationId(rpc), fetchIndexState(rpc)])
      .then(([nextConversationId, state]) => {
        if (alive) setIndexState(state);
        return load(nextConversationId);
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [rpc]);

  const reindex = async () => {
    try {
      const result = await requestReindex(rpc);
      if (!result.accepted) {
        setJumpState("Open or scroll a ChatGPT conversation before re-indexing.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const jump = async (item: OutlineItem) => {
    const messageId = item.evidence[0]?.messageId;
    if (!conversationId || !messageId) return;
    setJumpState("Re-locating source…");
    try {
      const result = await requestSourceJump(rpc, conversationId, messageId);
      if (result.status === "not-found") {
        setJumpState("Source not on screen.");
        return;
      }
      activeJump.current = result.requestId;
      const earlyResult = earlyJumpResults.current.get(result.requestId);
      if (earlyResult) {
        earlyJumpResults.current.delete(result.requestId);
        activeJump.current = null;
        setJumpState(
          earlyResult === "found" ? "Source highlighted." : "Source not on screen.",
        );
      }
    } catch (e) {
      setJumpState(`Source jump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copy = async (item: OutlineItem) => {
    try {
      await navigator.clipboard.writeText(item.summary);
      setJumpState("Copied.");
    } catch (e) {
      setJumpState(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const busy = indexState.kind === "capturing" || indexState.kind === "indexing";
  const grouped = GROUPS.map((group) => ({
    ...group,
    items: items?.filter((item) => item.type === group.type) ?? [],
  })).filter((group) => group.items.length > 0);

  return (
    <main class={styles.panel} data-testid="panel-outline">
      <header class={styles.header}>
        <div>
          <p class={styles.eyebrow}>GPT-Sidekick</p>
          <h1 class={styles.heading}>Conversation outline</h1>
        </div>
        <button
          class={styles.reindex}
          data-testid="reindex"
          type="button"
          disabled={!connected || busy}
          onClick={() => void reindex()}
        >
          {busy ? "Indexing…" : "Re-index"}
        </button>
      </header>

      <div
        class={styles.state}
        data-kind={indexState.kind}
        data-testid="index-state"
        role="status"
      >
        {formatIndexState(indexState)}
      </div>

      {error ? (
        <div class={styles.status} data-testid="panel-status" role="alert">
          Error: {error}
        </div>
      ) : items === null ? (
        <div class={styles.status} data-testid="panel-status">
          {connected
            ? "Connected — open or scroll a ChatGPT conversation to index it."
            : "Connecting…"}
        </div>
      ) : items.length === 0 ? (
        <div class={styles.status} data-testid="panel-status">
          No outline items yet. Re-index or scroll the conversation to capture more.
        </div>
      ) : (
        <div class={styles.groups}>
          {grouped.map((group) => (
            <section class={styles.group} data-testid="outline-group" key={group.type}>
              <h2 class={styles.groupHeading}>
                {group.label} <span>{group.items.length}</span>
              </h2>
              <ul class={styles.list}>
                {group.items.map((item) => {
                  const quote = item.evidence[0]?.quote.trim() ?? "";
                  // `title` is a prefix of its own evidence quote by construction
                  // (extractor `titleFrom`), so printing both repeated the line
                  // verbatim for the common short quote. Show only what the
                  // title leaves out; a quote that adds nothing gets no line.
                  // (Non-prefix titles stay possible — grounding uses `includes`
                  // — so fall back to the whole quote rather than mis-slicing.)
                  const preview = quote.startsWith(item.title)
                    ? quote.slice(item.title.length).trim()
                    : quote;
                  return (
                  <li class={styles.item} key={item.id}>
                    <button
                      class={styles.itemButton}
                      data-testid="outline-item"
                      type="button"
                      title={item.evidence[0]?.quote}
                      onClick={() => void jump(item)}
                    >
                      <span class={styles.title}>{item.title}</span>
                      {preview ? <span class={styles.quote}>{preview}</span> : null}
                    </button>
                    <button
                      class={styles.copyButton}
                      type="button"
                      aria-label={`Copy ${item.type}`}
                      onClick={() => void copy(item)}
                    >
                      Copy
                    </button>
                  </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {jumpState ? (
        <div class={styles.jumpState} data-testid="jump-state" role="status">
          {jumpState}
        </div>
      ) : null}
    </main>
  );
}

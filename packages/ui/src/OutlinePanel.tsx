import { useEffect, useState } from "preact/hooks";
import type { Rpc } from "@gpt-sidekick/core/protocol";
import type { OutlineItem } from "@gpt-sidekick/core/model";
import {
  fetchConversationId,
  fetchOutline,
  onOutlineChanged,
} from "@gpt-sidekick/core/service";
import * as styles from "./OutlinePanel.css";

/**
 * Minimal live outline (M3 replaces this with grouping + source-jump + copy).
 * Reads the SW-owned store over the §13 routed RPC: subscribe to change pushes
 * FIRST, then resolve which conversation this tab is showing, then fetch. A null
 * conversation id means "wait for the first push" (a static chat with a cold SW
 * registry only becomes known once it next captures).
 */
export function OutlinePanel({ rpc }: { rpc: Rpc }) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fail = (e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    };
    const load = async (conversationId: string | null) => {
      if (alive) setConnected(true); // the SW round-trip completed
      if (!conversationId) return;
      try {
        const outline = await fetchOutline(rpc, conversationId);
        if (alive) setItems(outline);
      } catch (e) {
        fail(e);
      }
    };
    // Subscribe before resolving, so a change during startup isn't missed.
    onOutlineChanged(rpc, (conversationId) => void load(conversationId));
    void fetchConversationId(rpc).then(load).catch(fail);
    return () => {
      alive = false;
    };
  }, [rpc]);

  if (error) {
    return (
      <div class={styles.status} data-testid="panel-status">
        Error: {error}
      </div>
    );
  }
  if (items === null) {
    return (
      <div class={styles.status} data-testid="panel-status">
        {connected
          ? "Connected — open or scroll a ChatGPT conversation to index it."
          : "Connecting…"}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div class={styles.status} data-testid="panel-status">
        No outline items yet — scroll the chat to index more.
      </div>
    );
  }

  return (
    <div class={styles.panel} data-testid="panel-outline">
      <h1 class={styles.heading}>Outline · {items.length}</h1>
      <ul class={styles.list}>
        {items.map((it) => (
          <li key={it.id} class={styles.item}>
            <span class={styles.type}>{it.type}</span>
            <span class={styles.title}>{it.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useState } from "preact/hooks";
import type { Rpc } from "@gpt-sidekick/core/protocol";
import * as styles from "./SidePanel.css";

/**
 * M0 side panel: an echo box proving the panel ⇄ SW-router round-trip.
 * The real outline UI replaces this in M3.
 */
export function SidePanel({ rpc }: { rpc: Rpc }) {
  const [input, setInput] = useState("");
  const [reply, setReply] = useState<string | null>(null);

  const send = async () => {
    try {
      const result = await rpc.request("echo", input);
      setReply(String(result));
    } catch (err) {
      setReply(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div class={styles.panel}>
      <h1>GPT-Sidekick</h1>
      <input
        data-testid="echo-input"
        value={input}
        onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        placeholder="Message to echo"
      />
      <button data-testid="echo-send" onClick={send}>
        Send
      </button>
      <div data-testid="echo-reply" class={styles.reply}>
        {reply ?? ""}
      </div>
    </div>
  );
}

/**
 * ChatGPT provider adapter — M0 seam only.
 *
 * M1 replaces this with the scroll-and-accumulate pass (SPEC §5.2): walk the
 * persistent `data-turn-id` skeleton, hydrate each turn, capture while
 * hydrated, upsert by [conversationId+messageId].
 */

export type TranscriptEvent = {
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

export function capture(): TranscriptEvent[] {
  throw new Error("NotImplemented: provider-chatgpt capture lands in M1");
}

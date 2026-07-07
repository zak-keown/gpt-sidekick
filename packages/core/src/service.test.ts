import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "./store";
import { RulesExtractor } from "./extractor";
import {
  SERVICE_KINDS,
  registerStoreService,
  type PushResult,
  type StoreServiceHost,
} from "./service";
import type { Address } from "./router";
import type { TranscriptEvent, TranscriptRecord } from "./model";

type Pushed = { target: Address; kind: string; payload: unknown };

/** A test double for the SW's routing host: captures handlers + pushes and lets
 *  a test invoke a handler with an attested `source`. */
function fakeHost() {
  const handlers = new Map<
    string,
    (payload: unknown, source: Address) => unknown | Promise<unknown>
  >();
  const pushes: Pushed[] = [];
  const host: StoreServiceHost = {
    handle: (kind, fn) => handlers.set(kind, fn),
    push: (target, kind, payload) => pushes.push({ target, kind, payload }),
  };
  return {
    host,
    pushes,
    async call(kind: string, payload: unknown, source: Address): Promise<unknown> {
      const fn = handlers.get(kind);
      if (!fn) throw new Error(`no handler for ${kind}`);
      return fn(payload, source);
    },
  };
}

const content = (tabId: number): Address => ({ context: "content", tabId });
const panel = (tabId: number): Address => ({ context: "panel", tabId });
const SW: Address = { context: "sw" };

/** An assistant turn whose fenced code block reliably yields one Code item. */
const codeEvent = (messageId: string, turnIndex: number): TranscriptEvent => ({
  provider: "chatgpt",
  conversationId: "c1",
  messageId,
  role: "assistant",
  text: "Here is the fix:\n```\nconst x = 1;\n```\n",
  turnIndex,
  messageIndex: 0,
  anchor: { kind: "dom", locator: `[data-message-id="${messageId}"]` },
});

describe("store service — SW-owned pipeline, source-aware", () => {
  it("indexes a push, notifies the pushing tab's panel, and maps tab→conversation", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    const h = fakeHost();
    registerStoreService(h.host, store, RulesExtractor);

    const result = (await h.call(
      SERVICE_KINDS.push,
      { events: [codeEvent("m1", 0)] },
      content(7),
    )) as PushResult;

    expect(result.messages).toBe(1);
    expect(result.written).toBe(true);
    expect(result.items).toBeGreaterThanOrEqual(1);

    // Piece 1: the SW pushed a change notice to the SAME tab's panel.
    expect(h.pushes).toContainEqual({
      target: panel(7),
      kind: SERVICE_KINDS.changed,
      payload: { conversationId: "c1" },
    });

    // Piece 2: the panel can now learn which conversation its tab shows.
    expect(await h.call(SERVICE_KINDS.conversation, {}, panel(7))).toBe("c1");

    // And the owning tab's panel can fetch the outline for that conversation.
    const outline = (await h.call(
      SERVICE_KINDS.outline,
      { conversationId: "c1" },
      panel(7),
    )) as unknown[];
    expect(outline).toHaveLength(result.items);
  });

  it("does not notify or map for a push from a non-content source", async () => {
    const h = fakeHost();
    registerStoreService(h.host, new InMemoryTranscriptStore(() => "T"), RulesExtractor);

    await h.call(SERVICE_KINDS.push, { events: [codeEvent("m1", 0)] }, SW);

    expect(h.pushes).toHaveLength(0);
    expect(await h.call(SERVICE_KINDS.conversation, {}, panel(7))).toBeNull();
  });

  it("returns null conversation for a tab that has not pushed", async () => {
    const h = fakeHost();
    registerStoreService(h.host, new InMemoryTranscriptStore(() => "T"), RulesExtractor);

    expect(await h.call(SERVICE_KINDS.conversation, {}, panel(99))).toBeNull();
  });

  it("serves a source-jump record and null when absent", async () => {
    const store = new InMemoryTranscriptStore(() => "T");
    const h = fakeHost();
    registerStoreService(h.host, store, RulesExtractor);
    await h.call(SERVICE_KINDS.push, { events: [codeEvent("m1", 0)] }, content(7));

    const rec = (await h.call(
      SERVICE_KINDS.record,
      { conversationId: "c1", messageId: "m1" },
      panel(7),
    )) as TranscriptRecord | null;
    expect(rec?.messageId).toBe("m1");
    expect(
      await h.call(SERVICE_KINDS.record, { conversationId: "c1", messageId: "x" }, panel(7)),
    ).toBeNull();
  });

  // Codex round (2026-07-07): targeted delivery doesn't cover reads — every
  // context may address the SW — so reads must be authorized against the
  // attested source, or a client can read another tab's conversation by id.
  describe("read authorization — the §13 tenant boundary for reads", () => {
    async function seededOnTab7() {
      const store = new InMemoryTranscriptStore(() => "T");
      const h = fakeHost();
      registerStoreService(h.host, store, RulesExtractor);
      await h.call(SERVICE_KINDS.push, { events: [codeEvent("m1", 0)] }, content(7));
      return h;
    }

    it("denies a panel reading a conversation its tab does not own", async () => {
      const h = await seededOnTab7();
      // panel@8 knows c1's id but its tab (8) is not mapped to c1.
      expect(await h.call(SERVICE_KINDS.outline, { conversationId: "c1" }, panel(8))).toEqual([]);
      expect(await h.call(SERVICE_KINDS.records, { conversationId: "c1" }, panel(8))).toEqual([]);
      expect(
        await h.call(SERVICE_KINDS.record, { conversationId: "c1", messageId: "m1" }, panel(8)),
      ).toBeNull();
    });

    it("denies a content script reading conversation data at all", async () => {
      const h = await seededOnTab7();
      expect(await h.call(SERVICE_KINDS.outline, { conversationId: "c1" }, content(7))).toEqual([]);
      expect(
        await h.call(SERVICE_KINDS.record, { conversationId: "c1", messageId: "m1" }, content(7)),
      ).toBeNull();
    });
  });
});

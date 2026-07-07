import type { OutlineItem, TranscriptEvent, TranscriptRecord } from "./model";

/**
 * Persistence seam (SPEC §7). DOM-free interface so `core` never depends on
 * IndexedDB/Dexie; the Dexie-backed impl lives in a storage adapter, the
 * in-memory impl here powers unit tests + the extract pipeline.
 */
export interface TranscriptStore {
  /** Idempotent upsert by [conversationId+messageId]; assigns/keeps ordinal. */
  upsertRecords(events: TranscriptEvent[]): Promise<TranscriptRecord[]>;
  /** Records for a conversation, in ordinal order. */
  getRecords(conversationId: string): Promise<TranscriptRecord[]>;
  /** Single-record lookup — the source-jump path. */
  getRecord(
    conversationId: string,
    messageId: string,
  ): Promise<TranscriptRecord | undefined>;
  putOutline(conversationId: string, items: OutlineItem[]): Promise<void>;
  getOutline(conversationId: string): Promise<OutlineItem[]>;
}

/** Non-cryptographic FNV-1a hash of canonical text — drift detection + reuse. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly records = new Map<string, Map<string, TranscriptRecord>>();
  private readonly outlines = new Map<string, OutlineItem[]>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async upsertRecords(events: TranscriptEvent[]): Promise<TranscriptRecord[]> {
    const out: TranscriptRecord[] = [];
    for (const event of events) {
      let conversation = this.records.get(event.conversationId);
      if (!conversation) {
        conversation = new Map();
        this.records.set(event.conversationId, conversation);
      }
      const existing = conversation.get(event.messageId);
      const record: TranscriptRecord = {
        ...event,
        // Re-capture keeps the message's position + first-capture time.
        ordinal: existing ? existing.ordinal : conversation.size,
        capturedAt: existing ? existing.capturedAt : this.now(),
        textHash: hashText(event.text),
      };
      conversation.set(event.messageId, record);
      out.push(record);
    }
    return out;
  }

  async getRecords(conversationId: string): Promise<TranscriptRecord[]> {
    const conversation = this.records.get(conversationId);
    if (!conversation) return [];
    return [...conversation.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  async getRecord(
    conversationId: string,
    messageId: string,
  ): Promise<TranscriptRecord | undefined> {
    return this.records.get(conversationId)?.get(messageId);
  }

  async putOutline(conversationId: string, items: OutlineItem[]): Promise<void> {
    this.outlines.set(conversationId, items);
  }

  async getOutline(conversationId: string): Promise<OutlineItem[]> {
    return this.outlines.get(conversationId) ?? [];
  }
}

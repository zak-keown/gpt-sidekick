import Dexie, { type Table } from "dexie";
import type {
  OutlineItem,
  TranscriptEvent,
  TranscriptRecord,
} from "@gpt-sidekick/core/model";
import {
  hashText,
  type RecordsSnapshot,
  type TranscriptStore,
} from "@gpt-sidekick/core/store";

type OutlineRow = { conversationId: string; items: OutlineItem[] };
type MetaRow = { conversationId: string; recordRevision: number };

class GptSidekickDb extends Dexie {
  records!: Table<TranscriptRecord, [string, string]>;
  outlines!: Table<OutlineRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    // §7: compound PK gives O(log n) source-jump; conversationId indexes the pass.
    this.version(1).stores({
      records: "[conversationId+messageId], conversationId, ordinal",
      outlines: "conversationId",
      meta: "conversationId",
    });
  }
}

/** Distinct messages always differ in (turnIndex, messageIndex); messageId is a
 *  deterministic final tiebreak so ordering is stable across instances. */
function byPosition(a: TranscriptRecord, b: TranscriptRecord): number {
  return (
    a.turnIndex - b.turnIndex ||
    a.messageIndex - b.messageIndex ||
    (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0)
  );
}

/**
 * Dexie/IndexedDB implementation of core's `TranscriptStore` (SPEC §7). Lives in
 * an adapter, not core, because IndexedDB is a browser API. Behaviourally
 * identical to `InMemoryTranscriptStore` — same idempotent upsert, backfill-safe
 * (turnIndex, messageIndex) ordering, revision compare-and-swap — but durable,
 * and the CAS runs inside a transaction so the revision check and write are atomic.
 */
export class DexieTranscriptStore implements TranscriptStore {
  private readonly db: GptSidekickDb;

  constructor(
    name = "gpt-sidekick",
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db = new GptSidekickDb(name);
  }

  async upsertRecords(events: TranscriptEvent[]): Promise<TranscriptRecord[]> {
    const byConversation = new Map<string, TranscriptEvent[]>();
    for (const event of events) {
      const list = byConversation.get(event.conversationId);
      if (list) list.push(event);
      else byConversation.set(event.conversationId, [event]);
    }

    await this.db.transaction("rw", this.db.records, this.db.meta, async () => {
      for (const [conversationId, group] of byConversation) {
        for (const event of group) {
          const existing = await this.db.records.get([
            conversationId,
            event.messageId,
          ]);
          await this.db.records.put({
            ...event,
            ordinal: 0, // reassigned by the renumber below
            capturedAt: existing ? existing.capturedAt : this.now(),
            textHash: hashText(event.text),
          });
        }

        // Renumber ordinals 0..n-1 by stable position (backfill-safe).
        const all = await this.db.records
          .where("conversationId")
          .equals(conversationId)
          .toArray();
        all.sort(byPosition);
        for (let i = 0; i < all.length; i++) {
          const record = all[i];
          if (record && record.ordinal !== i) {
            await this.db.records.put({ ...record, ordinal: i });
          }
        }

        const metaRow = await this.db.meta.get(conversationId);
        await this.db.meta.put({
          conversationId,
          recordRevision: (metaRow?.recordRevision ?? 0) + 1,
        });
      }
    });

    const out: TranscriptRecord[] = [];
    for (const event of events) {
      const record = await this.db.records.get([
        event.conversationId,
        event.messageId,
      ]);
      if (record) out.push(record);
    }
    return out;
  }

  async getRecords(conversationId: string): Promise<TranscriptRecord[]> {
    const all = await this.db.records
      .where("conversationId")
      .equals(conversationId)
      .toArray();
    return all.sort((a, b) => a.ordinal - b.ordinal);
  }

  async getRecord(
    conversationId: string,
    messageId: string,
  ): Promise<TranscriptRecord | undefined> {
    return this.db.records.get([conversationId, messageId]);
  }

  async snapshot(conversationId: string): Promise<RecordsSnapshot> {
    return this.db.transaction("r", this.db.records, this.db.meta, async () => {
      const all = await this.db.records
        .where("conversationId")
        .equals(conversationId)
        .toArray();
      all.sort((a, b) => a.ordinal - b.ordinal);
      const meta = await this.db.meta.get(conversationId);
      return { records: all, revision: meta?.recordRevision ?? 0 };
    });
  }

  async putOutline(
    conversationId: string,
    items: OutlineItem[],
    basedOnRevision: number,
  ): Promise<boolean> {
    return this.db.transaction(
      "rw",
      this.db.meta,
      this.db.outlines,
      async () => {
        const meta = await this.db.meta.get(conversationId);
        const current = meta?.recordRevision ?? 0;
        if (basedOnRevision !== current) return false;
        await this.db.outlines.put({ conversationId, items });
        return true;
      },
    );
  }

  async getOutline(conversationId: string): Promise<OutlineItem[]> {
    const row = await this.db.outlines.get(conversationId);
    return row?.items ?? [];
  }
}

import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedSnapshotStore, type CapturePolicy } from '../src/background/storage';
import type { Snapshot } from '../src/core/types';

it('persists complete independent snapshots and deletion across store instances', async () => {
  const factory = new IDBFactory();
  const first = new IndexedSnapshotStore(factory);
  const snapshot: Snapshot = { conversationId: 'one', title: 'One', phase: 'partial', messages: [], items: [],
    progress: { capturedTurns: 2, totalTurns: 8, unstableMessages: 1 }, updatedAt: '2026-10-18', droppedCandidates: 3, error: 'Missing turns' };
  await first.put(snapshot);
  await first.put({ ...snapshot, conversationId: 'two' });
  const restarted = new IndexedSnapshotStore(factory);
  expect(await restarted.get('one')).toEqual(snapshot);
  await restarted.delete('one');
  expect(await first.get('one')).toBeNull();
  expect((await first.get('two'))?.conversationId).toBe('two');
  await restarted.clear();
  expect(await first.get('two')).toBeNull();
});

it('rolls back snapshot deletion when policy cannot commit, for one and all conversations', async () => {
  const store = new IndexedSnapshotStore(new IDBFactory());
  const snapshot: Snapshot = { conversationId: 'one', title: 'One', phase: 'ready', messages: [], items: [],
    progress: { capturedTurns: 0, totalTurns: 0, unstableMessages: 0 }, updatedAt: '', droppedCandidates: 0 };
  const policy: CapturePolicy = { pauseAll: false, paused: [], resumed: [], streams: [] };
  await store.commitCapture(snapshot, policy);
  const invalid = { ...policy, uncloneable: () => undefined } as CapturePolicy;
  for (const id of ['one', null]) {
    await expect(store.commitDeletion(id, invalid)).rejects.toThrow();
    expect(await store.get('one')).toEqual(snapshot);
    expect(await store.getPolicy()).toEqual(policy);
  }
  const deleted: CapturePolicy = { ...policy, pauseAll: true };
  await store.commitDeletion(null, deleted);
  expect(await store.get('one')).toBeNull();
  expect(await store.getPolicy()).toEqual(deleted);
});

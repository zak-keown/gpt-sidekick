import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BackgroundController, validBatch, type BackgroundAPI, type Sender, type TabInfo } from '../src/background/controller';
import { IndexedSnapshotStore } from '../src/background/storage';
import type { CaptureBatch, ContentCommand, Snapshot } from '../src/core/types';

const panel: Sender = { id: 'extension', url: 'chrome-extension://extension/sidepanel.html' };
const content: Sender = { id: 'extension', frameId: 0, url: 'https://chatgpt.com/c/one', tab: { id: 1, windowId: 10, url: 'https://chatgpt.com/c/one' } };
function batch(sequence = 0, runId = 'run'): CaptureBatch {
  return { conversationId: 'one', title: 'One', runId, sequence, mode: 'passive', phase: 'ready',
    progress: { capturedTurns: 1, totalTurns: 1, unstableMessages: 0 },
    messages: [{ id: 'message', conversationId: 'one', role: 'user', text: `Remember item ${sequence}`, ordinal: 0 }] };
}
function setup() {
  const tabs = new Map<number, TabInfo>([
    [1, { id: 1, windowId: 10, url: 'https://chatgpt.com/c/one' }],
    [2, { id: 2, windowId: 20, url: 'https://chatgpt.com/c/two' }],
  ]);
  const sent: { id: number; command: ContentCommand }[] = [];
  const api: BackgroundAPI = {
    runtimeId: 'extension', panelUrl: panel.url!,
    async queryTabs(query) { return [...tabs.values()].filter(tab => query.windowId === undefined || tab.windowId === query.windowId); },
    async getTab(id) { return tabs.get(id)!; },
    async send(id, command) { sent.push({ id, command }); return { ok: true }; },
  };
  const store = new IndexedSnapshotStore(new IDBFactory());
  return { api, store, tabs, sent, controller: new BackgroundController(api, store) };
}

describe('background trust and lifecycle', () => {
  it('accepts finite scroll hints and rejects invalid traversal metadata', () => {
    const capture = batch();
    capture.progress.coverage = 'traversed';
    capture.messages[0]!.scrollAnchor = { top: 120, height: 900 };
    expect(validBatch(capture)).toBe(true);
    for (const scrollAnchor of [{ top: -1, height: 900 }, { top: Infinity, height: 900 }, { top: 0, height: 0 }]) {
      expect(validBatch({ ...capture, messages: [{ ...capture.messages[0], scrollAnchor }] })).toBe(false);
    }
    expect(validBatch({ ...capture, progress: { ...capture.progress, coverage: 'unknown' } })).toBe(false);
  });

  it('requires the exact panel origin and derives the active tab within its window', async () => {
    const { controller } = setup();
    expect(await controller.handle({ kind: 'panel/state', windowId: 20, tabId: 1 }, panel)).toMatchObject({ tabId: 2, supported: true, snapshot: null });
    expect(await controller.handle({ kind: 'panel/state', windowId: 10 }, { ...panel, url: `${panel.url}?spoof` })).toMatchObject({ ok: false });
    expect(await controller.handle({ kind: 'panel/state', windowId: -1 }, panel)).toMatchObject({ ok: false });
  });
  it('rejects subframes, forged conversations, malformed payloads, and navigation races', async () => {
    const { controller, tabs, store } = setup();
    for (const [capture, sender] of [
      [batch(), { ...content, frameId: 2 }],
      [{ ...batch(), conversationId: 'two' }, content],
      [{ ...batch(), messages: [{ ...batch().messages[0], text: 123 }] }, content],
    ] as const) expect(await controller.handle({ kind: 'content/capture', batch: capture }, sender)).toMatchObject({ ok: false });
    tabs.set(1, { id: 1, windowId: 10, url: 'https://chatgpt.com/c/two' });
    expect(await controller.handle({ kind: 'content/capture', batch: batch() }, content)).toMatchObject({ ok: false });
    expect(await store.get('one')).toBeNull();
  });
  it('serializes concurrent writes and rejects retired runs across worker restarts', async () => {
    const { controller, api, store } = setup();
    await Promise.all([0, 1, 2].map(sequence => controller.handle({ kind: 'content/capture', batch: batch(sequence) }, content)));
    expect((await store.get('one'))?.messages[0]?.text).toBe('Remember item 2');
    const restarted = new BackgroundController(api, store);
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(1) }, content)).toMatchObject({ ok: false });
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(0, 'new') }, content)).toEqual({ ok: true });
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(3) }, content)).toMatchObject({ ok: false });
  });
  it('deletion stays paused through worker restart and rejects old runs after reindex', async () => {
    const { controller, api, store, sent } = setup();
    await controller.handle({ kind: 'content/capture', batch: batch() }, content);
    await controller.handle({ kind: 'panel/delete', windowId: 10 }, panel);
    expect(sent[0]).toMatchObject({ id: 1, command: { kind: 'content/reset' } });
    const restarted = new BackgroundController(api, store);
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(1) }, content)).toMatchObject({ ok: false });
    expect(await store.get('one')).toBeNull();
    await restarted.handle({ kind: 'panel/reindex', windowId: 10 }, panel);
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(2) }, content)).toMatchObject({ ok: false });
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(0, 'new') }, content)).toEqual({ ok: true });
  });
  it('deletes all snapshots and blocks captures from other tabs until reindex', async () => {
    const { controller, api, store, sent } = setup();
    await controller.handle({ kind: 'content/capture', batch: batch() }, content);
    await controller.handle({ kind: 'panel/delete-all', windowId: 10 }, panel);
    expect(sent.map(event => event.id)).toEqual([1, 2]);
    const restarted = new BackgroundController(api, store);
    expect(await restarted.handle({ kind: 'content/capture', batch: batch(0, 'other') }, content)).toMatchObject({ ok: false });
    expect(await store.get('one')).toBeNull();
    expect(await store.getPolicy()).toEqual({ pauseAll: true, paused: [], resumed: [], streams: [], owners: [], pendingOwners: [] });
  });
  it('uses stored, verified evidence for jump commands', async () => {
    const { controller, store, sent } = setup();
    const message = batch().messages[0]!;
    await store.put({ ...batch(), items: [{ id: 'item', category: 'note', title: 'Remember', evidence: { messageId: message.id, quote: 'Remember', start: 0, end: 8 } }], updatedAt: '', droppedCandidates: 0 } as Snapshot);
    expect(await controller.handle({ kind: 'panel/jump', windowId: 10, itemId: 'item', evidence: { quote: 'forged' } }, panel)).toEqual({ ok: true });
    expect(sent[0]?.command).toMatchObject({ kind: 'content/jump', message, evidence: { quote: 'Remember' } });
    expect(await controller.handle({ kind: 'panel/jump', windowId: 10, itemId: 'missing' }, panel)).toMatchObject({ ok: false });
  });
  it('reports provider rejection of reindex commands', async () => {
    const { controller, api } = setup();
    api.send = async () => ({ ok: false, error: 'Conversation changed' });
    expect(await controller.handle({ kind: 'panel/reindex', windowId: 10 }, panel)).toEqual({ ok: false, error: 'Conversation changed' });
  });
  it('prevents another same-conversation tab from overwriting or viewing a different version', async () => {
    const { controller, api, tabs, store } = setup();
    tabs.set(2, { id: 2, windowId: 20, url: 'https://chatgpt.com/c/one' });
    const other = { ...content, tab: tabs.get(2)! };
    await controller.handle({ kind: 'content/capture', batch: batch(0) }, content);
    await controller.handle({ kind: 'content/capture', batch: { ...batch(1), mode: 'full', messages: [{ ...batch().messages[0]!, text: 'Newest complete message' }] } }, content);
    expect(await controller.handle({ kind: 'content/capture', batch: batch(2, 'other') }, other)).toMatchObject({ ok: false });
    expect((await store.get('one'))?.messages[0]?.text).toBe('Newest complete message');
    const restarted = new BackgroundController(api, store);
    expect(await restarted.handle({ kind: 'panel/state', windowId: 20 }, panel)).toMatchObject({ snapshot: null, error: expect.stringContaining('another tab') });
    await restarted.handle({ kind: 'panel/reindex', windowId: 20 }, panel);
    expect(await restarted.handle({ kind: 'panel/state', windowId: 20 }, panel)).toMatchObject({ snapshot: null });
    await restarted.handle({ kind: 'content/capture', batch: batch(1, 'other') }, other);
    expect((await store.get('one'))?.messages[0]?.text).toBe('Remember item 1');
    expect(await restarted.handle({ kind: 'panel/state', windowId: 10 }, panel)).toMatchObject({ snapshot: null, error: expect.stringContaining('another tab') });
  });
  it('reports storage failure without losing saved data and clears it after a successful retry', async () => {
    const { controller, store } = setup();
    await controller.handle({ kind: 'content/capture', batch: batch() }, content);
    const commit = store.commitCapture.bind(store);
    store.commitCapture = async () => { throw new Error('Quota exceeded'); };
    expect(await controller.handle({ kind: 'content/capture', batch: batch(1) }, content)).toMatchObject({ ok: false });
    expect(await controller.handle({ kind: 'panel/state', windowId: 10 }, panel)).toMatchObject({ error: 'Could not save capture: Quota exceeded', snapshot: { messages: [{ text: 'Remember item 0' }] } });
    store.commitCapture = commit;
    expect(await controller.handle({ kind: 'content/capture', batch: batch(1) }, content)).toEqual({ ok: true });
    expect(await controller.handle({ kind: 'panel/state', windowId: 10 }, panel)).not.toHaveProperty('error');
  });
  it('shows trusted capture limit failures in panel state', async () => {
    const { controller } = setup();
    const oversized = { ...batch(), messages: [{ ...batch().messages[0]!, text: 'a'.repeat(2_000_001) }] };
    expect(await controller.handle({ kind: 'content/capture', batch: oversized }, content)).toMatchObject({ ok: false });
    expect(await controller.handle({ kind: 'panel/state', windowId: 10 }, panel)).toMatchObject({ error: expect.stringContaining('supported limits') });
    await controller.handle({ kind: 'content/capture', batch: batch() }, content);
    expect(await controller.handle({ kind: 'panel/state', windowId: 10 }, panel)).not.toHaveProperty('error');
  });
});

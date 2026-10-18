import { applyBatch } from '../core/snapshot';
import { conversationIdFromUrl, type CaptureBatch, type ContentCommand, type PanelState } from '../core/types';
import type { CapturePolicy, SnapshotStore } from './storage';

export interface TabInfo { id?: number; windowId?: number; url?: string }
export interface Sender { id?: string; url?: string; frameId?: number; tab?: TabInfo }
export interface BackgroundAPI {
  runtimeId: string;
  panelUrl: string;
  queryTabs(query: { active?: boolean; windowId?: number; url?: string[] }): Promise<TabInfo[]>;
  getTab(id: number): Promise<TabInfo>;
  send(id: number, command: ContentCommand): Promise<unknown>;
}

interface Stream { conversationId: string; runId: string; sequence: number; retired: Set<string> }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function validBatch(value: unknown): value is CaptureBatch {
  if (!object(value) || !string(value.conversationId, 200) || !/^[a-zA-Z0-9-]+$/.test(value.conversationId) ||
      !string(value.title, 1000) || !string(value.runId, 200) || !value.runId || !integer(value.sequence) ||
      !['capturing', 'ready', 'partial', 'failed'].includes(String(value.phase)) ||
      !['passive', 'full'].includes(String(value.mode)) ||
      (value.error !== undefined && !string(value.error, 2000)) || !object(value.progress) ||
      !integer(value.progress.capturedTurns) || !integer(value.progress.totalTurns) || !integer(value.progress.unstableMessages) ||
      !Array.isArray(value.messages) || value.messages.length > 10000) return false;
  const ids = new Set<string>();
  let total = 0;
  return value.messages.every(message => {
    if (!object(message) || !string(message.id, 300) || !message.id || ids.has(message.id) ||
        message.conversationId !== value.conversationId || !['user', 'assistant', 'system', 'tool'].includes(String(message.role)) ||
        !string(message.text, 2_000_000) || !integer(message.ordinal) ||
        (message.turnId !== undefined && !string(message.turnId, 300))) return false;
    ids.add(message.id);
    total += message.text.length;
    return total <= 20_000_000;
  });
}

export class BackgroundController {
  private tail: Promise<unknown> = Promise.resolve();
  private streams = new Map<number, Stream>();
  private pausedConversations = new Set<string>();
  private pauseAll = false;
  private resumedConversations = new Set<string>();
  private loaded = false;
  private owners = new Map<string, number>();
  private pendingOwners = new Set<string>();
  private captureErrors = new Map<string, string>();

  constructor(private api: BackgroundAPI, private store: SnapshotStore) {}

  private async loadPolicy(): Promise<void> {
    if (this.loaded) return;
    const policy = await this.store.getPolicy();
    if (policy) {
      this.pauseAll = policy.pauseAll;
      this.pausedConversations = new Set(policy.paused);
      this.resumedConversations = new Set(policy.resumed);
      this.streams = new Map(policy.streams.map(([tab, stream]) => [tab, { ...stream, retired: new Set(stream.retired) }]));
      this.owners = new Map(policy.owners ?? []);
      this.pendingOwners = new Set(policy.pendingOwners ?? []);
    }
    this.loaded = true;
  }

  private policy(): CapturePolicy {
    return {
      pauseAll: this.pauseAll, paused: [...this.pausedConversations], resumed: [...this.resumedConversations],
      streams: [...this.streams].map(([tab, stream]) => [tab, { ...stream, retired: [...stream.retired] }]),
      owners: [...this.owners],
      pendingOwners: [...this.pendingOwners],
    };
  }

  private savePolicy(): Promise<void> {
    return this.store.setPolicy(this.policy());
  }

  handle(payload: unknown, sender: Sender): Promise<unknown> {
    // One queue covers capture, reads, and deletion so a deletion cannot race a write.
    const result = this.tail.then(() => this.dispatch(payload, sender));
    this.tail = result.catch(() => undefined);
    return result.catch(error => ({ ok: false, error: error instanceof Error ? error.message : 'Background request failed' }));
  }

  private async active(windowId: unknown): Promise<TabInfo> {
    if (!integer(windowId)) throw new Error('Invalid browser window');
    const tabs = await this.api.queryTabs({ active: true, windowId });
    const tab = tabs[0];
    if (!tab || !integer(tab.id) || tab.windowId !== windowId) throw new Error('No active tab in this window');
    return tab;
  }

  private async state(tab: TabInfo): Promise<PanelState> {
    const id = conversationIdFromUrl(tab.url ?? '');
    if (id && this.owners.has(id) && this.owners.get(id) !== tab.id) {
      return { tabId: tab.id, supported: true, snapshot: null,
        error: 'This conversation is being captured in another tab. Reindex here to switch capture to this tab.' };
    }
    const error = id ? this.captureErrors.get(`${tab.id}:${id}`) : undefined;
    return { tabId: tab.id, supported: id !== null, snapshot: id && !this.pendingOwners.has(id) ? await this.store.get(id) : null, ...(error ? { error } : {}) };
  }

  private async dispatch(payload: unknown, sender: Sender): Promise<unknown> {
    await this.loadPolicy();
    if (!object(payload)) throw new Error('Invalid request');
    if (payload.kind === 'content/capture') return this.capture(payload.batch, sender);
    if (sender.id !== this.api.runtimeId || sender.url !== this.api.panelUrl) throw new Error('Unauthorized panel');
    if (!['panel/state', 'panel/reindex', 'panel/jump', 'panel/delete', 'panel/delete-all'].includes(String(payload.kind))) throw new Error('Unknown request');
    const tab = await this.active(payload.windowId);
    if (payload.kind === 'panel/state') return this.state(tab);
    if (payload.kind === 'panel/delete-all') {
      this.pauseAll = true;
      this.resumedConversations.clear();
      this.pausedConversations.clear();
      this.streams.clear();
      this.owners.clear();
      this.pendingOwners.clear();
      this.captureErrors.clear();
      await this.store.commitDeletion(null, this.policy());
      const tabs = await this.api.queryTabs({ url: ['https://chatgpt.com/*'] });
      void Promise.allSettled(tabs.filter(t => integer(t.id)).map(t => this.api.send(t.id!, { kind: 'content/reset' })));
      return { ok: true };
    }
    const id = conversationIdFromUrl(tab.url ?? '');
    if (!id || !integer(tab.id)) throw new Error('Open a ChatGPT conversation');
    if (payload.kind === 'panel/delete') {
      this.pausedConversations.add(id);
      this.resumedConversations.delete(id);
      for (const stream of this.streams.values()) {
        if (stream.conversationId === id) stream.retired.add(stream.runId);
      }
      this.owners.delete(id);
      this.pendingOwners.delete(id);
      for (const key of this.captureErrors.keys()) if (key.endsWith(`:${id}`)) this.captureErrors.delete(key);
      await this.store.commitDeletion(id, this.policy());
      void this.api.send(tab.id, { kind: 'content/reset' }).catch(() => undefined);
      return { ok: true };
    }
    if (payload.kind === 'panel/reindex') {
      this.pausedConversations.delete(id);
      this.resumedConversations.add(id);
      if (this.owners.get(id) !== tab.id) this.pendingOwners.add(id);
      this.owners.set(id, tab.id);
      // Retain the last run so delayed messages from it cannot undo the restart.
      const stream = this.streams.get(tab.id);
      if (stream) stream.retired.add(stream.runId);
      await this.savePolicy();
      return this.api.send(tab.id, { kind: 'content/reindex' });
    }
    if (!string(payload.itemId, 300)) throw new Error('Invalid outline item');
    const snapshot = await this.store.get(id);
    const item = snapshot?.items.find(candidate => candidate.id === payload.itemId);
    const message = snapshot?.messages.find(candidate => candidate.id === item?.evidence.messageId);
    const evidence = item?.evidence;
    if (!message || !evidence || !integer(evidence.start) || !integer(evidence.end) || evidence.end <= evidence.start ||
        evidence.end > message.text.length || message.text.slice(evidence.start, evidence.end) !== evidence.quote) throw new Error('Source evidence is unavailable');
    const current = await this.api.getTab(tab.id);
    if (conversationIdFromUrl(current.url ?? '') !== id) throw new Error('Conversation changed');
    return this.api.send(tab.id, { kind: 'content/jump', conversationId: id, message, evidence });
  }

  private async capture(batch: unknown, sender: Sender): Promise<unknown> {
    if (sender.id !== this.api.runtimeId || !integer(sender.tab?.id) || sender.frameId !== 0) throw new Error('Invalid content capture');
    const tabId = sender.tab.id;
    const id = conversationIdFromUrl(sender.url ?? '');
    if (!id || !object(batch) || id !== batch.conversationId || conversationIdFromUrl(sender.tab.url ?? '') !== id) throw new Error('Capture identity mismatch');
    const current = await this.api.getTab(tabId);
    if (conversationIdFromUrl(current.url ?? '') !== id) throw new Error('Stale conversation');
    if (!validBatch(batch)) {
      this.captureErrors.set(`${tabId}:${id}`, 'Capture exceeded supported limits or contained invalid message data. Reindex to try again.');
      throw new Error('Invalid content capture or capture exceeds supported limits');
    }
    if (this.pausedConversations.has(id) || (this.pauseAll && !this.resumedConversations.has(id))) return { ok: false, error: 'Capture paused after deletion' };
    const owner = this.owners.get(id);
    if (owner !== undefined && owner !== tabId) {
      const ownerTab = await this.api.getTab(owner).catch(() => undefined);
      if (conversationIdFromUrl(ownerTab?.url ?? '') === id) return { ok: false, error: 'Index this tab to take over conversation capture' };
    }
    const previousStream = this.streams.get(tabId);
    let stream = previousStream ? { ...previousStream, retired: new Set(previousStream.retired) } : undefined;
    if (stream?.conversationId !== id) stream = undefined;
    if (stream && (stream.retired.has(batch.runId) || (stream.runId === batch.runId && batch.sequence <= stream.sequence))) return { ok: false, error: 'Stale capture' };
    if (stream && stream.runId !== batch.runId) {
      if (batch.sequence > 1) return { ok: false, error: 'Missing capture start' };
      stream.retired.add(stream.runId);
    }
    let next;
    try {
      next = applyBatch(this.pendingOwners.has(id) || (owner !== undefined && owner !== tabId) ? null : await this.store.get(id), batch);
    } catch (error) {
      this.captureErrors.set(`${tabId}:${id}`, `Could not save capture: ${error instanceof Error ? error.message : 'storage failure'}`);
      throw error;
    }
    // Navigation may have occurred while opening IndexedDB.
    if (conversationIdFromUrl((await this.api.getTab(tabId)).url ?? '') !== id) throw new Error('Stale conversation');
    this.streams.set(tabId, { conversationId: id, runId: batch.runId, sequence: batch.sequence, retired: stream?.retired ?? new Set() });
    this.owners.set(id, tabId);
    const pending = this.pendingOwners.delete(id);
    try {
      await this.store.commitCapture(next, this.policy());
    } catch (error) {
      if (previousStream) this.streams.set(tabId, previousStream);
      else this.streams.delete(tabId);
      if (owner === undefined) this.owners.delete(id);
      else this.owners.set(id, owner);
      if (pending) this.pendingOwners.add(id);
      this.captureErrors.set(`${tabId}:${id}`, `Could not save capture: ${error instanceof Error ? error.message : 'storage failure'}`);
      throw error;
    }
    this.captureErrors.delete(`${tabId}:${id}`);
    return { ok: true };
  }
}

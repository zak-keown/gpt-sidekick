import type { Snapshot } from '../core/types';

export interface CapturePolicy {
  pauseAll: boolean;
  paused: string[];
  resumed: string[];
  streams: [number, { conversationId: string; runId: string; sequence: number; retired: string[] }][];
  owners?: [string, number][];
  pendingOwners?: string[];
}

export interface SnapshotStore {
  get(id: string): Promise<Snapshot | null>;
  put(snapshot: Snapshot): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  getPolicy(): Promise<CapturePolicy | null>;
  setPolicy(policy: CapturePolicy): Promise<void>;
  commitCapture(snapshot: Snapshot, policy: CapturePolicy): Promise<void>;
  commitDeletion(id: string | null, policy: CapturePolicy): Promise<void>;
}

/** Each operation commits before resolving, including across worker restarts. */
export class IndexedSnapshotStore implements SnapshotStore {
  private database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB, name = 'gpt-sidekick-v1') {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('snapshots')) request.result.createObjectStore('snapshots', { keyPath: 'conversationId' });
        if (!request.result.objectStoreNames.contains('policy')) request.result.createObjectStore('policy');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  private async operation<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, table = 'snapshots'): Promise<T> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(table, mode);
      const request = action(transaction.objectStore(table));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Storage transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  }

  async get(id: string): Promise<Snapshot | null> {
    return (await this.operation<Snapshot | undefined>('readonly', store => store.get(id))) ?? null;
  }
  async put(snapshot: Snapshot): Promise<void> {
    await this.operation('readwrite', store => store.put(snapshot));
  }
  async delete(id: string): Promise<void> {
    await this.operation('readwrite', store => store.delete(id));
  }
  async clear(): Promise<void> {
    await this.operation('readwrite', store => store.clear());
  }
  async getPolicy(): Promise<CapturePolicy | null> {
    return (await this.operation<CapturePolicy | undefined>('readonly', store => store.get('capture'), 'policy')) ?? null;
  }
  async setPolicy(policy: CapturePolicy): Promise<void> {
    await this.operation('readwrite', store => store.put(policy, 'capture'), 'policy');
  }
  async commitCapture(snapshot: Snapshot, policy: CapturePolicy): Promise<void> {
    await this.mutateWithPolicy(store => { store.put(snapshot); }, policy);
  }
  async commitDeletion(id: string | null, policy: CapturePolicy): Promise<void> {
    await this.mutateWithPolicy(store => { if (id === null) store.clear(); else store.delete(id); }, policy);
  }
  private async mutateWithPolicy(mutate: (store: IDBObjectStore) => void, policy: CapturePolicy): Promise<void> {
    const database = await this.database;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['snapshots', 'policy'], 'readwrite');
      try {
        mutate(transaction.objectStore('snapshots'));
        transaction.objectStore('policy').put(policy, 'capture');
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Capture transaction aborted'));
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

import { wrap, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Change, Cursor, EntityName, Row } from '../protocol/types';
import { StorageVersionError } from './errors';
import { LOCAL_SCHEMA, migrations } from './idb-migrations';
import { clearLegacyState, readLegacyState, type LegacySource, type LegacyState } from './legacy-localstorage';
import type { PersistedState, PullCommit, StoredMutation, StoredRejection, SyncStorage } from './types';
import { newClientId } from './whole-state-storage';

interface Meta {
  clientId: string;
  cursor: Cursor | null;
  lastMutationId: number;
  nextMutationId: number;
}

interface EntityRecord {
  entity: EntityName;
  siteId: string;
  data: Row;
}

const STORES = ['meta', 'entities', 'mutations', 'rejections'] as const;
type StoreName = (typeof STORES)[number];
type Tx = IDBPTransaction<unknown, StoreName[], 'readwrite'>;

export interface IdbStorageOptions {
  legacy?: LegacySource | null;
  idGen?: () => string;
}

async function readMeta(tx: Tx, newId: () => string): Promise<Meta> {
  const store = tx.objectStore('meta');
  const [clientId, cursor, lastMutationId, nextMutationId] = await Promise.all(
    (['clientId', 'cursor', 'lastMutationId', 'nextMutationId'] as const).map((k) => store.get(k)),
  );
  if (typeof clientId === 'string') {
    return { clientId, cursor: cursor ?? null, lastMutationId, nextMutationId };
  }
  // First use, created inside the same transaction so two tabs can never both create an id.
  const meta: Meta = { clientId: newId(), cursor: null, lastMutationId: 0, nextMutationId: 1 };
  await writeMeta(tx, meta);
  return meta;
}

async function writeMeta(tx: Tx, meta: Meta): Promise<void> {
  const store = tx.objectStore('meta');
  await Promise.all(Object.entries(meta).map(([key, value]) => store.put(value, key)));
}

function entityRecord(c: Change): EntityRecord {
  return { entity: c.entity, siteId: c.siteId, data: c.data as Row };
}

function writeLegacy(tx: IDBTransaction, legacy: LegacyState, newId: () => string): void {
  const meta = tx.objectStore('meta');
  meta.put(legacy.clientId ?? newId(), 'clientId');
  meta.put(null, 'cursor');
  meta.put(legacy.lastMutationId, 'lastMutationId');
  meta.put(legacy.nextMutationId, 'nextMutationId');
  const entities = tx.objectStore('entities');
  for (const [key, row] of legacy.base) {
    entities.put({ entity: key.slice(0, key.indexOf('/')), siteId: row.siteId, data: row }, key);
  }
  for (const m of legacy.pending) tx.objectStore('mutations').put(m);
  // The store assigns ids; the old ones may collide with rejections already there.
  for (const r of legacy.rejections) {
    const record: Partial<StoredRejection> = { ...r };
    delete record.id;
    tx.objectStore('rejections').add(record);
  }
}

export class IdbStorage implements SyncStorage {
  private db?: Promise<IDBPDatabase>;
  private upgradedElsewhere = false;
  private closed = false;
  private generation = 0;
  private readonly versionListeners = new Set<() => void>();
  private readonly newId: () => string;

  constructor(
    private readonly name: string,
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly opts: IdbStorageOptions = {},
  ) {
    this.newId = opts.idGen ?? newClientId;
  }

  async load(): Promise<PersistedState> {
    const tx = await this.tx();
    const state = await this.readAll(tx, await readMeta(tx, this.newId));
    await tx.done;
    return state;
  }

  async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const tx = await this.tx(['meta', 'mutations']);
    const meta = await readMeta(tx, this.newId);
    const stored: StoredMutation = { ...m, id: meta.nextMutationId };
    await tx.objectStore('mutations').put(stored);
    meta.nextMutationId += 1;
    await writeMeta(tx, meta);
    await tx.done;
    return stored;
  }

  async commitPull(c: PullCommit): Promise<boolean> {
    const tx = await this.tx();
    const meta = await readMeta(tx, this.newId);
    if (meta.cursor !== c.expectedCursor) {
      await tx.done;
      return false;
    }

    const entities = tx.objectStore('entities');
    if (c.snapshot) await entities.clear();
    for (const change of c.snapshot ?? c.changes ?? []) {
      const key = `${change.entity}/${change.id}`;
      if (change.op === 'put' && change.data) await entities.put(entityRecord(change), key);
      else await entities.delete(key);
    }
    meta.cursor = c.cursor;

    if (c.lastMutationId !== null) {
      const acked = c.lastMutationId;
      const reasons = new Map(c.rejections.map((r) => [r.mutationId, r]));
      const at = c.receivedAt ?? new Date().toISOString();
      const mutations = tx.objectStore('mutations');
      for (const m of (await mutations.getAll()) as StoredMutation[]) {
        if (m.id > acked) break;
        const r = reasons.get(m.id);
        if (r) {
          const rejection: Omit<StoredRejection, 'id'> = {
            mutation: m,
            code: r.code,
            message: r.message,
            ...(r.details === undefined ? {} : { details: r.details }),
            at,
          };
          await tx.objectStore('rejections').add(rejection);
        }
        await mutations.delete(m.id);
      }
      meta.lastMutationId = Math.max(meta.lastMutationId, acked);
      meta.nextMutationId = Math.max(meta.nextMutationId, meta.lastMutationId + 1);
    }
    await writeMeta(tx, meta);
    await tx.done;
    return true;
  }

  async dismissRejection(rejectionId: number): Promise<void> {
    const tx = await this.tx(['rejections']);
    await tx.objectStore('rejections').delete(rejectionId);
    await tx.done;
  }

  async resetClient(): Promise<PersistedState> {
    const tx = await this.tx();
    const meta = await readMeta(tx, this.newId);
    const mutations = tx.objectStore('mutations');
    const pending = (await mutations.getAll()) as StoredMutation[];
    await mutations.clear();
    for (const [i, m] of pending.entries()) await mutations.put({ ...m, id: i + 1 });
    Object.assign(meta, { clientId: this.newId(), lastMutationId: 0, nextMutationId: pending.length + 1 });
    await writeMeta(tx, meta);
    const state = await this.readAll(tx, meta);
    await tx.done;
    return state;
  }

  onVersionChange(listener: () => void): () => void {
    this.versionListeners.add(listener);
    return () => this.versionListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    const db = this.db;
    this.db = undefined;
    void db?.then((d) => d.close()).catch(() => undefined);
  }

  private async readAll(tx: Tx, meta: Meta): Promise<PersistedState> {
    const entities = tx.objectStore('entities');
    const [keys, records, pending, rejections] = await Promise.all([
      entities.getAllKeys(),
      entities.getAll() as Promise<EntityRecord[]>,
      tx.objectStore('mutations').getAll() as Promise<StoredMutation[]>,
      tx.objectStore('rejections').getAll() as Promise<StoredRejection[]>,
    ]);
    return {
      clientId: meta.clientId,
      cursor: meta.cursor,
      lastMutationId: meta.lastMutationId,
      base: new Map(keys.map((k, i) => [String(k), records[i].data])),
      pending,
      rejections,
    };
  }

  private async tx(stores: StoreName[] = [...STORES]): Promise<Tx> {
    return (await this.open()).transaction(stores, 'readwrite') as unknown as Tx;
  }

  private open(): Promise<IDBPDatabase> {
    if (this.closed) return Promise.reject(new Error('The storage is closed'));
    if (this.upgradedElsewhere) {
      return Promise.reject(new Error('The local database was upgraded by a newer version of the app; reload'));
    }
    if (!this.factory) return Promise.reject(new Error('IndexedDB is not available'));
    if (this.db) return this.db;
    const generation = ++this.generation;
    this.db = (async () => {
      const legacySource = this.opts.legacy === undefined ? globalThis.localStorage : this.opts.legacy;
      let imported = false;
      const request = this.factory.open(this.name, LOCAL_SCHEMA);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction as IDBTransaction;
        for (let v = event.oldVersion + 1; v <= LOCAL_SCHEMA; v++) migrations[v](db, tx);
        const legacy = event.oldVersion === 0 && legacySource ? readLegacyState(legacySource) : undefined;
        if (legacy) {
          writeLegacy(tx, legacy, this.newId);
          imported = true;
        }
      };
      let db: IDBPDatabase;
      try {
        db = (await wrap(request)) as IDBPDatabase;
      } catch (err) {
        // Not cached: the next call tries again. A newer schema means this app is older than the data.
        if (this.generation === generation) this.db = undefined;
        if ((err as { name?: unknown } | null)?.name === 'VersionError') throw new StorageVersionError({ cause: err });
        throw err;
      }
      // Removed only after the upgrade committed: a failed upgrade must not lose the old state.
      if (imported && legacySource) clearLegacyState(legacySource);
      db.addEventListener('versionchange', () => {
        db.close();
        this.upgradedElsewhere = true;
        for (const listener of this.versionListeners) listener();
      });
      // The browser closed it (site data cleared, disk error): the next call opens a new connection.
      db.addEventListener('close', () => {
        if (this.generation === generation) this.db = undefined;
      });
      return db;
    })();
    return this.db;
  }
}

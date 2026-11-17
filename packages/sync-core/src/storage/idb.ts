import { wrap, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Change, Cursor, EntityName, Row } from '../protocol/types';
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
  /** Where an older web app kept its state; imported once when the database is created. Default: localStorage. */
  legacy?: LegacySource | null;
}

async function readMeta(tx: Tx): Promise<Meta> {
  const store = tx.objectStore('meta');
  const [clientId, cursor, lastMutationId, nextMutationId] = await Promise.all(
    (['clientId', 'cursor', 'lastMutationId', 'nextMutationId'] as const).map((k) => store.get(k)),
  );
  if (typeof clientId === 'string') {
    return { clientId, cursor: cursor ?? null, lastMutationId, nextMutationId };
  }
  // First use, created inside the same transaction so two tabs can never both create an id.
  const meta: Meta = { clientId: newClientId(), cursor: null, lastMutationId: 0, nextMutationId: 1 };
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

/** Writes an imported legacy state into a freshly created database (raw API: runs in the upgrade transaction). */
function writeLegacy(tx: IDBTransaction, legacy: LegacyState): void {
  const meta = tx.objectStore('meta');
  meta.put(legacy.clientId ?? newClientId(), 'clientId');
  meta.put(null, 'cursor'); // a full pull rebuilds `base` against the server's current state
  meta.put(legacy.lastMutationId, 'lastMutationId');
  meta.put(legacy.nextMutationId, 'nextMutationId');
  const entities = tx.objectStore('entities');
  for (const [key, row] of legacy.base) {
    entities.put({ entity: key.slice(0, key.indexOf('/')), siteId: row.siteId, data: row }, key);
  }
  for (const m of legacy.pending) tx.objectStore('mutations').put(m);
  for (const r of legacy.rejections) tx.objectStore('rejections').put(r);
}

/**
 * Durable client storage in IndexedDB. Every method is a single `readwrite` transaction over the stores it
 * touches; IndexedDB runs overlapping transactions on the same stores one after another, also across tabs,
 * which is what makes `enqueue` and `commitPull` safe with several tabs open.
 */
export class IdbStorage implements SyncStorage {
  private db?: Promise<IDBPDatabase>;
  private upgradedElsewhere = false;
  private readonly versionListeners = new Set<() => void>();

  constructor(
    private readonly name: string,
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly opts: IdbStorageOptions = {},
  ) {}

  async load(): Promise<PersistedState> {
    const tx = await this.tx();
    const state = await this.readAll(tx, await readMeta(tx));
    await tx.done;
    return state;
  }

  async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const tx = await this.tx(['meta', 'mutations']);
    const meta = await readMeta(tx);
    const stored: StoredMutation = { ...m, id: meta.nextMutationId };
    await tx.objectStore('mutations').put(stored);
    meta.nextMutationId += 1;
    await writeMeta(tx, meta);
    await tx.done;
    return stored;
  }

  async commitPull(c: PullCommit): Promise<boolean> {
    const tx = await this.tx();
    const meta = await readMeta(tx);
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
      const at = new Date().toISOString();
      const mutations = tx.objectStore('mutations');
      for (const m of (await mutations.getAll()) as StoredMutation[]) {
        if (m.id > acked) break; // keys are ascending
        const r = reasons.get(m.id);
        if (r) {
          const rejection: StoredRejection = {
            mutation: m,
            code: r.code,
            message: r.message,
            ...(r.details === undefined ? {} : { details: r.details }),
            at,
          };
          await tx.objectStore('rejections').put(rejection);
        }
        await mutations.delete(m.id);
      }
      // Never backwards: a lower value means the server lost this client or does not own it.
      meta.lastMutationId = Math.max(meta.lastMutationId, acked);
      meta.nextMutationId = Math.max(meta.nextMutationId, meta.lastMutationId + 1);
    }
    await writeMeta(tx, meta);
    await tx.done;
    return true;
  }

  async dismissRejection(mutationId: number): Promise<void> {
    const tx = await this.tx(['rejections']);
    await tx.objectStore('rejections').delete(mutationId);
    await tx.done;
  }

  async resetClient(): Promise<PersistedState> {
    const tx = await this.tx();
    const meta = await readMeta(tx);
    const mutations = tx.objectStore('mutations');
    const pending = (await mutations.getAll()) as StoredMutation[];
    await mutations.clear();
    for (const [i, m] of pending.entries()) await mutations.put({ ...m, id: i + 1 });
    Object.assign(meta, { clientId: newClientId(), lastMutationId: 0, nextMutationId: pending.length + 1 });
    await writeMeta(tx, meta);
    const state = await this.readAll(tx, meta);
    await tx.done;
    return state;
  }

  /** Called when a newer version of the app (another tab) upgrades the database; this connection is closed. */
  onVersionChange(listener: () => void): () => void {
    this.versionListeners.add(listener);
    return () => this.versionListeners.delete(listener);
  }

  close(): void {
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
    if (this.upgradedElsewhere) {
      return Promise.reject(new Error('The local database was upgraded by a newer version of the app; reload'));
    }
    if (!this.factory) return Promise.reject(new Error('IndexedDB is not available'));
    this.db ??= (async () => {
      const legacySource = this.opts.legacy === undefined ? globalThis.localStorage : this.opts.legacy;
      let imported = false;
      const request = this.factory.open(this.name, LOCAL_SCHEMA);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction as IDBTransaction;
        for (let v = event.oldVersion + 1; v <= LOCAL_SCHEMA; v++) migrations[v](db, tx);
        const legacy = event.oldVersion === 0 && legacySource ? readLegacyState(legacySource) : undefined;
        if (legacy) {
          writeLegacy(tx, legacy);
          imported = true;
        }
      };
      const db = (await wrap(request)) as IDBPDatabase;
      // Removed only after the upgrade committed: a failed upgrade must not lose the old state.
      if (imported && legacySource) clearLegacyState(legacySource);
      db.addEventListener('versionchange', () => {
        db.close();
        this.upgradedElsewhere = true;
        for (const listener of this.versionListeners) listener();
      });
      return db;
    })();
    return this.db;
  }
}

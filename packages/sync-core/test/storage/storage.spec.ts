import 'fake-indexeddb/auto';
import { randomUUID } from 'crypto';
import {
  IdbStorage,
  LEGACY_CLIENT_ID_KEY,
  LOCAL_SCHEMA,
  LEGACY_STATE_KEY,
  LocalStorageSyncStorage,
  MemoryStorage,
  SyncClient,
  type Change,
  type Cursor,
  type Row,
  type StoredMutation,
  type SyncStorage,
} from '../../src';
import { ScriptedTransport } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const cursor = (c: string) => c as Cursor;
const row = (id: string, fields: Partial<Row> = {}): Row => ({ id, siteId: SITE, title: id, ...fields });
const put = (id: string, fields: Partial<Row> = {}): Change => ({
  version: 1,
  entity: 'ticket',
  id,
  siteId: SITE,
  op: 'put',
  data: row(id, fields),
});
const del = (id: string): Change => ({ version: 1, entity: 'ticket', id, siteId: SITE, op: 'del', data: null });
const mutation = (title: string): Omit<StoredMutation, 'id'> => ({
  name: 'ticket.create',
  args: { id: randomUUID(), siteId: SITE, title, description: '' },
  createdAt: '2026-01-01T10:00:00.000Z',
});
const page = (expected: string | null, next: string, rest: Partial<Parameters<SyncStorage['commitPull']>[0]> = {}) => ({
  expectedCursor: expected === null ? null : cursor(expected),
  cursor: cursor(next),
  lastMutationId: null,
  rejections: [],
  ...rest,
});

function fakeLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const backends: [string, () => () => SyncStorage][] = [
  [
    'MemoryStorage',
    () => {
      const storage = new MemoryStorage();
      return () => storage;
    },
  ],
  [
    'LocalStorageSyncStorage',
    () => {
      (globalThis as { localStorage?: Storage }).localStorage = fakeLocalStorage();
      return () => new LocalStorageSyncStorage('fs_state');
    },
  ],
  [
    'IdbStorage',
    () => {
      const name = `fieldsync-test-${randomUUID()}`;
      return () => new IdbStorage(name, indexedDB, { legacy: null });
    },
  ],
];

describe.each(backends)('%s', (_name, backend) => {
  let open: () => SyncStorage;
  const handles: SyncStorage[] = [];
  const handle = () => {
    const h = open();
    handles.push(h);
    return h;
  };
  beforeEach(() => {
    open = backend();
  });
  afterEach(() => {
    for (const h of handles.splice(0)) h.close();
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('creates the client id once, the same for every handle', async () => {
    const first = await handle().load();
    expect(first.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toMatchObject({ cursor: null, lastMutationId: 0, pending: [], rejections: [] });
    expect((await handle().load()).clientId).toBe(first.clientId);
  });

  it('numbers queued mutations 1, 2, 3 and keeps them in order', async () => {
    const s = handle();
    const ids = [];
    for (const title of ['a', 'b', 'c']) ids.push((await s.enqueue(mutation(title))).id);
    expect(ids).toEqual([1, 2, 3]);
    const { pending } = await handle().load();
    expect(pending.map((m) => [m.id, m.args.title, m.createdAt])).toEqual([
      [1, 'a', '2026-01-01T10:00:00.000Z'],
      [2, 'b', '2026-01-01T10:00:00.000Z'],
      [3, 'c', '2026-01-01T10:00:00.000Z'],
    ]);
  });

  it('hands out unique ids to concurrent writers sharing the storage', async () => {
    const a = handle();
    const b = handle();
    const stored = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).enqueue(mutation(`m${i}`))));
    expect(stored.map((m) => m.id).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await handle().load()).pending).toHaveLength(20);
  });

  it('returns copies: changing what it returned does not change what is stored', async () => {
    const s = handle();
    const stored = await s.enqueue(mutation('a'));
    stored.args.title = 'changed';
    (await s.load()).pending[0].args.title = 'changed too';
    expect((await handle().load()).pending[0].args.title).toBe('a');
  });

  it('refuses a commit whose expected cursor is stale and changes nothing', async () => {
    const s = handle();
    await s.enqueue(mutation('a'));
    expect(await s.commitPull(page('somebody-else', 'c1', { changes: [put('x')], lastMutationId: 1 }))).toBe(false);
    const state = await handle().load();
    expect(state).toMatchObject({ cursor: null, lastMutationId: 0 });
    expect(state.base.size).toBe(0);
    expect(state.pending).toHaveLength(1);
  });

  it('applies a page that is not the last one without touching the queue', async () => {
    const s = handle();
    await s.enqueue(mutation('a'));
    expect(await s.commitPull(page(null, 'c1', { changes: [put('x'), put('y')] }))).toBe(true);
    const state = await handle().load();
    expect(state.cursor).toBe('c1');
    expect([...state.base.keys()].sort()).toEqual(['ticket/x', 'ticket/y']);
    expect(state.pending).toHaveLength(1);
    expect(state.lastMutationId).toBe(0);
  });

  it('on the last page retires acknowledged mutations and keeps rejected ones with their reason', async () => {
    const s = handle();
    for (const title of ['a', 'b', 'c']) await s.enqueue(mutation(title));
    await s.commitPull(page(null, 'c1', { changes: [put('x'), put('y')] }));
    const committed = await s.commitPull(
      page('c1', 'c2', {
        changes: [del('y'), put('x', { title: 'x2' })],
        lastMutationId: 2,
        rejections: [
          { mutationId: 2, code: 'STATUS_CONFLICT', message: 'Status is now "open"', details: { current: 'open' } },
          { mutationId: 3, code: 'NO_ACCESS', message: 'not yet acknowledged' },
        ],
      }),
    );
    expect(committed).toBe(true);
    const state = await handle().load();
    expect([...state.base]).toEqual([['ticket/x', row('x', { title: 'x2' })]]);
    expect(state.pending.map((m) => m.id)).toEqual([3]);
    expect(state.lastMutationId).toBe(2);
    expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]).toMatchObject({
      mutation: { id: 2, args: { title: 'b' } },
      code: 'STATUS_CONFLICT',
      details: { current: 'open' },
    });
  });

  it('never lowers lastMutationId and never reuses an acknowledged id', async () => {
    const s = handle();
    await s.commitPull(page(null, 'c1', { lastMutationId: 7 }));
    expect((await s.enqueue(mutation('a'))).id).toBe(8);
    await s.commitPull(page('c1', 'c2', { lastMutationId: 0 }));
    expect((await handle().load()).lastMutationId).toBe(7);
    expect((await s.enqueue(mutation('b'))).id).toBe(9);
  });

  it('replaces the whole base with a snapshot and keeps the queue', async () => {
    const s = handle();
    await s.commitPull(page(null, 'c1', { changes: [put('x'), put('y')] }));
    await s.enqueue(mutation('a'));
    await s.commitPull(page('c1', 's1', { snapshot: [put('z')] }));
    const state = await handle().load();
    expect([...state.base.keys()]).toEqual(['ticket/z']);
    expect(state.pending).toHaveLength(1);
  });

  it('dismisses a rejection', async () => {
    const s = handle();
    await s.enqueue(mutation('a'));
    await s.commitPull(page(null, 'c1', { lastMutationId: 1, rejections: [{ mutationId: 1, code: 'NO_ACCESS', message: 'gone' }] }));
    const [rejection] = (await s.load()).rejections;
    await s.dismissRejection(rejection.id);
    expect((await handle().load()).rejections).toHaveLength(0);
  });

  it('keeps a rejection from before a client reset apart from a new one with the same mutation id', async () => {
    const s = handle();
    const reject = (expected: string | null, next: string, message: string) =>
      s.commitPull(page(expected, next, { lastMutationId: 1, rejections: [{ mutationId: 1, code: 'NO_ACCESS', message }] }));
    await s.enqueue(mutation('old'));
    await reject(null, 'c1', 'old one');
    await s.resetClient();
    await s.enqueue(mutation('new'));
    await reject('c1', 'c2', 'new one');

    const { rejections } = await handle().load();
    expect(rejections.map((r) => [r.mutation.id, r.message])).toEqual([
      [1, 'old one'],
      [1, 'new one'],
    ]);
    expect(new Set(rejections.map((r) => r.id)).size).toBe(2);
    await s.dismissRejection(rejections[0].id);
    expect((await handle().load()).rejections.map((r) => r.message)).toEqual(['new one']);
  });

  it('resets the client: new id, queue renumbered from 1, data and cursor kept', async () => {
    const s = handle();
    await s.commitPull(page(null, 'c1', { changes: [put('x')], lastMutationId: 4 }));
    await s.enqueue(mutation('a'));
    await s.enqueue(mutation('b'));
    const before = await s.load();
    const after = await s.resetClient();
    expect(after.clientId).not.toBe(before.clientId);
    expect(after.pending.map((m) => [m.id, m.args.title])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(after).toMatchObject({ cursor: 'c1', lastMutationId: 0 });
    expect([...after.base.keys()]).toEqual(['ticket/x']);
    expect((await s.enqueue(mutation('c'))).id).toBe(3);
    expect((await handle().load()).clientId).toBe(after.clientId);
  });

  it('keeps everything across close and reopen', async () => {
    const s = handle();
    await s.commitPull(page(null, 'c1', { changes: [put('x')] }));
    await s.enqueue(mutation('a'));
    const before = await s.load();
    s.close();
    const reopened = await handle().load();
    expect(reopened).toEqual(before);
  });
});

describe('MemoryStorage specifics', () => {
  it('takes its client ids from idGen when one is given', async () => {
    const ids = ['first', 'second'];
    const s = new MemoryStorage({ idGen: () => ids.shift() ?? 'exhausted' });
    expect((await s.load()).clientId).toBe('first');
    expect((await s.resetClient()).clientId).toBe('second');
  });
});

function openRaw(name: string, version?: number, upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction as IDBTransaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

describe('IdbStorage specifics', () => {
  const name = () => `fieldsync-test-${randomUUID()}`;

  it('migrates a version 1 database and keeps its queue, ids and order, and its data', async () => {
    const db = name();
    const part = { id: 'p1', ticketId: 't1', siteId: SITE, name: 'belt', quantity: 1 };
    const queued = [3, 4, 5].map((id) => ({ ...mutation(`q${id}`), id }));
    const v1 = await openRaw(db, 1, (raw, tx) => {
      raw.createObjectStore('meta');
      const entities = raw.createObjectStore('entities');
      entities.createIndex('entity', 'entity');
      entities.createIndex('siteId', 'siteId');
      raw.createObjectStore('mutations', { keyPath: 'id' });
      raw.createObjectStore('rejections', { keyPath: 'mutation.id' });
      const meta = tx.objectStore('meta');
      meta.put('v1-client', 'clientId');
      meta.put('v1-cursor', 'cursor');
      meta.put(2, 'lastMutationId');
      meta.put(6, 'nextMutationId');
      tx.objectStore('entities').put({ entity: 'ticket', siteId: SITE, data: row('t1') }, 'ticket/t1');
      tx.objectStore('entities').put({ entity: 'part', siteId: SITE, data: part }, 'part/p1');
      for (const m of [queued[2], queued[0], queued[1]]) tx.objectStore('mutations').put(m);
    });
    v1.close();

    const s = new IdbStorage(db, indexedDB, { legacy: null });
    const state = await s.load();
    expect(state).toMatchObject({ clientId: 'v1-client', cursor: 'v1-cursor', lastMutationId: 2 });
    expect(state.pending).toEqual(queued);
    expect([...state.base].sort()).toEqual([
      ['part/p1', part],
      ['ticket/t1', row('t1')],
    ]);
    expect((await s.enqueue(mutation('next'))).id).toBe(6);
    s.close();

    const migrated = await openRaw(db);
    expect(migrated.version).toBe(LOCAL_SCHEMA);
    const index = migrated.transaction('entities').objectStore('entities').index('ticketId');
    expect(await result(index.getAllKeys('t1'))).toEqual(['part/p1']);
    migrated.close();
  });

  it('imports the starter blob once: its data under a new client id, whose counter it cannot trust', async () => {
    const ls = fakeLocalStorage();
    ls.setItem(LEGACY_CLIENT_ID_KEY, 'legacy-client');
    ls.setItem(LEGACY_STATE_KEY, JSON.stringify({ cursor: 42, lastMutationId: 5, base: { 'ticket/t': row('t') } }));
    const s = new IdbStorage(name(), indexedDB, { legacy: ls });
    const state = await s.load();
    expect(state).toMatchObject({ cursor: null, lastMutationId: 0, pending: [] });
    expect(state.clientId).not.toBe('legacy-client');
    expect([...state.base]).toEqual([['ticket/t', row('t')]]);
    expect((await s.enqueue(mutation('a'))).id).toBe(1);
    expect(ls.getItem(LEGACY_STATE_KEY)).toBeNull();
    expect(ls.getItem(LEGACY_CLIENT_ID_KEY)).toBeNull();
    s.close();
  });

  it('imports the localStorage storage state with its unsynced queue', async () => {
    const ls = fakeLocalStorage();
    const pending = [1, 2].map((id) => ({ ...mutation(`q${id}`), id: 4 + id }));
    ls.setItem(
      LEGACY_STATE_KEY,
      JSON.stringify({
        clientId: 'p31-client',
        cursor: 'some-v2-cursor',
        lastMutationId: 4,
        nextMutationId: 7,
        base: [['ticket/t', row('t')]],
        pending,
        rejections: [],
      }),
    );
    const s = new IdbStorage(name(), indexedDB, { legacy: ls });
    const state = await s.load();
    expect(state).toMatchObject({ clientId: 'p31-client', cursor: null, lastMutationId: 4 });
    expect(state.pending.map((m) => [m.id, m.args.title])).toEqual([
      [5, 'q1'],
      [6, 'q2'],
    ]);
    expect((await s.enqueue(mutation('next'))).id).toBe(7);
    expect(ls.getItem(LEGACY_STATE_KEY)).toBeNull();
    s.close();
  });

  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a blob without base', JSON.stringify({ cursor: 3, lastMutationId: 2 })],
    ['a row without a site', JSON.stringify({ cursor: 3, lastMutationId: 2, base: { 'ticket/t': { id: 't' } } })],
  ])('opens normally when the legacy state is %s', async (_label, raw) => {
    const ls = fakeLocalStorage();
    ls.setItem(LEGACY_STATE_KEY, raw);
    const s = new IdbStorage(name(), indexedDB, { legacy: ls });
    expect(await s.load()).toMatchObject({ lastMutationId: 0, pending: [], rejections: [] });
    s.close();
  });

  it('migrates rejections of a version 2 database, which were keyed by mutation id', async () => {
    const db = name();
    const rejection = { mutation: { ...mutation('a'), id: 4 }, code: 'NO_ACCESS', message: 'gone', at: '2026-01-01T10:00:00.000Z' };
    const v2 = await openRaw(db, 2, (raw, tx) => {
      raw.createObjectStore('meta');
      const entities = raw.createObjectStore('entities');
      entities.createIndex('entity', 'entity');
      entities.createIndex('siteId', 'siteId');
      entities.createIndex('ticketId', 'data.ticketId');
      raw.createObjectStore('mutations', { keyPath: 'id' });
      raw.createObjectStore('rejections', { keyPath: 'mutation.id' });
      tx.objectStore('meta').put('v2-client', 'clientId');
      tx.objectStore('rejections').put(rejection);
    });
    v2.close();

    const s = new IdbStorage(db, indexedDB, { legacy: null });
    const { rejections } = await s.load();
    expect(rejections).toEqual([{ ...rejection, id: expect.any(Number) }]);
    await s.dismissRejection(rejections[0].id);
    expect((await s.load()).rejections).toEqual([]);
    s.close();
  });

  it('imports nothing into a database that already exists', async () => {
    const db = name();
    const first = new IdbStorage(db, indexedDB, { legacy: null });
    const { clientId } = await first.load();
    first.close();
    const ls = fakeLocalStorage();
    ls.setItem(LEGACY_STATE_KEY, JSON.stringify({ cursor: 1, lastMutationId: 9, base: {} }));
    const second = new IdbStorage(db, indexedDB, { legacy: ls });
    expect(await second.load()).toMatchObject({ clientId, lastMutationId: 0 });
    expect(ls.getItem(LEGACY_STATE_KEY)).not.toBeNull();
    second.close();
  });

  it('closes when a newer app version upgrades the database, and the client blocks with "upgrade"', async () => {
    const db = name();
    const storage = new IdbStorage(db, indexedDB, { legacy: null });
    const client = new SyncClient({ transport: new ScriptedTransport(), storage, env: {} });
    await client.ready;
    const notified = jest.fn();
    storage.onVersionChange(notified);

    const newer = indexedDB.open(db, LOCAL_SCHEMA + 1);
    await new Promise<void>((resolve, reject) => {
      newer.onsuccess = () => resolve();
      newer.onerror = () => reject(newer.error);
      newer.onblocked = () => reject(new Error('blocked: the old connection did not close'));
    });
    newer.result.close();

    expect(notified).toHaveBeenCalledTimes(1);
    expect(client.facts.blocked).toBe('upgrade');
    await expect(storage.load()).rejects.toThrow(/upgraded/);
    client.dispose();
  });
});

import {
  MemoryStorage,
  SyncClient,
  type Change,
  type Cursor,
  type MutatorName,
  type PullResponse,
  type Row,
} from '../../src';
import { ScriptedTransport, deferred, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T0 = '2026-01-01T09:00:00.000Z';

const ticket = (id: string, fields: Partial<Row> = {}): Row => ({
  id,
  siteId: SITE,
  title: 'untitled',
  description: '',
  status: 'open',
  assigneeId: null,
  createdAt: T0,
  updatedAt: T0,
  ...fields,
});
const put = (version: number, row: Row): Change => ({
  version,
  entity: 'ticket',
  id: String(row.id),
  siteId: SITE,
  op: 'put',
  data: row,
});
const del = (version: number, id: string): Change => ({
  version,
  entity: 'ticket',
  id,
  siteId: SITE,
  op: 'del',
  data: null,
});
const page = (
  changes: Change[],
  cursor: string,
  last: { hasMore: boolean; lastMutationId: number | null },
): PullResponse => ({
  mode: 'delta',
  changes,
  cursor: cursor as Cursor,
  rejections: [],
  ...last,
});

/** Storage whose base already holds `rows` (cursor `c0`), as after an earlier sync. */
async function seeded(rows: Row[]): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await storage.load();
  await storage.commitPull({
    expectedCursor: null,
    cursor: 'c0' as Cursor,
    changes: rows.map((r, i) => put(i + 1, r)),
    lastMutationId: 0,
    rejections: [],
  });
  return storage;
}

const enqueue = (storage: MemoryStorage, name: MutatorName, args: Record<string, unknown>) =>
  storage.enqueue({ name, args, createdAt: '2026-01-01T10:00:00.000Z' });

/**
 * The view is always the server's base with every unacknowledged local mutation replayed on top, whatever the
 * base does underneath; mutations leave the queue only when a pull acknowledges them.
 */
describe('rebase of pending mutations', () => {
  const clients: SyncClient[] = [];
  const open = (storage: MemoryStorage, transport = new ScriptedTransport()) => {
    const c = new SyncClient({ transport, storage });
    clients.push(c);
    return c;
  };
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
  });

  it('shows a changed base with the pending patch on top', async () => {
    const storage = await seeded([ticket(A, { title: 'old title', description: 'old text' })]);
    const rest = deferred<PullResponse>();
    const transport = new ScriptedTransport()
      .replyPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      // Another user's edit arrives on a page that does not acknowledge our mutation yet.
      .replyPull(
        page([put(2, ticket(A, { title: 'old title', description: 'their text' }))], 'c1', {
          hasMore: true,
          lastMutationId: null,
        }),
        rest.promise,
      );
    const client = open(storage, transport);
    await client.ready;

    await client.mutate('ticket.update', { id: A, patch: { title: 'my title' } });
    await flush();
    expect(transport.callsOf('pull')).toHaveLength(2);

    expect(client.view().get(`ticket/${A}`)).toMatchObject({ title: 'my title', description: 'their text' });
    expect((await storage.load()).pending.map((m) => m.id)).toEqual([1]);
    rest.reject(new Error('test over'));
  });

  it('keeps the mutation queued when its row is deleted underneath', async () => {
    const storage = await seeded([ticket(A, { title: 'old title' })]);
    const rest = deferred<PullResponse>();
    const transport = new ScriptedTransport()
      .replyPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      .replyPull(page([del(2, A)], 'c1', { hasMore: true, lastMutationId: null }), rest.promise);
    const client = open(storage, transport);
    await client.ready;

    await client.mutate('ticket.update', { id: A, patch: { title: 'my title' } });
    await flush();
    expect(transport.callsOf('pull')).toHaveLength(2);

    expect(client.view().has(`ticket/${A}`)).toBe(false);
    expect(client.pendingCount).toBe(1);
    expect((await storage.load()).pending.map((m) => m.id)).toEqual([1]);
    rest.reject(new Error('test over'));
  });

  it('keeps and replays the whole queue, in order, when a snapshot replaces the base', async () => {
    const storage = await seeded([ticket(A, { title: 'old title' }), ticket(B)]);
    await enqueue(storage, 'ticket.update', { id: A, patch: { title: 'first' } });
    await enqueue(storage, 'ticket.setStatus', { id: A, from: 'open', to: 'in_progress' });
    await enqueue(storage, 'ticket.update', { id: A, patch: { title: 'second' } });

    // Snapshot pages are committed through storage exactly like delta pages.
    const { cursor } = await storage.load();
    const snapshot = [put(10, ticket(A, { title: 'server title', description: 'server text' })), put(11, ticket(D))];
    expect(
      await storage.commitPull({
        expectedCursor: cursor,
        cursor: 's1' as Cursor,
        snapshot,
        lastMutationId: null,
        rejections: [],
      }),
    ).toBe(true);

    const client = open(storage);
    await client.ready;

    expect((await storage.load()).pending.map((m) => [m.id, m.name])).toEqual([
      [1, 'ticket.update'],
      [2, 'ticket.setStatus'],
      [3, 'ticket.update'],
    ]);
    const view = client.view();
    expect([...view.keys()].sort()).toEqual([`ticket/${A}`, `ticket/${D}`]);
    expect(view.get(`ticket/${A}`)).toMatchObject({
      title: 'second',
      description: 'server text',
      status: 'in_progress',
    });
  });

  it('lets a snapshot pull replace the base and keeps the queue on top of it', async () => {
    const storage = await seeded([ticket(A, { title: 'old title' }), ticket(B)]);
    await enqueue(storage, 'ticket.update', { id: A, patch: { title: 'mine' } });
    const transport = new ScriptedTransport()
      .replyPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      // Access changed: B's site is gone, D's is new. The pull is taken before mutation 1 committed.
      .replyPull({
        ...page([put(5, ticket(A, { title: 'server title', description: 'server text' })), put(6, ticket(D))], 's1', {
          hasMore: false,
          lastMutationId: 0,
        }),
        mode: 'snapshot',
        reason: 'access_changed',
      });
    const client = open(storage, transport);
    await client.ready;

    await client.sync();

    const state = await storage.load();
    expect([...state.base.keys()].sort()).toEqual([`ticket/${A}`, `ticket/${D}`]);
    expect(state.pending.map((m) => m.id)).toEqual([1]);
    expect([...client.view().keys()].sort()).toEqual([`ticket/${A}`, `ticket/${D}`]);
    expect(client.view().get(`ticket/${A}`)).toMatchObject({ title: 'mine', description: 'server text' });
  });

  it('drops exactly the acknowledged mutations and replays the rest on the new base', async () => {
    const storage = await seeded([ticket(A, { title: 'old title' })]);
    await enqueue(storage, 'ticket.update', { id: A, patch: { title: 'first' } });
    await enqueue(storage, 'ticket.setStatus', { id: A, from: 'open', to: 'in_progress' });
    await enqueue(storage, 'ticket.update', { id: A, patch: { title: 'second' } });
    const transport = new ScriptedTransport()
      .replyPush({
        results: [1, 2, 3].map((id) => ({ id, status: 'applied' as const })),
        lastMutationId: 3,
      })
      // The pull's snapshot was taken after mutations 1 and 2 committed, before 3.
      .replyPull(
        page([put(2, ticket(A, { title: 'first', status: 'in_progress' }))], 'c1', {
          hasMore: false,
          lastMutationId: 2,
        }),
      );
    const client = open(storage, transport);
    await client.ready;

    await client.sync();
    await flush();

    expect((await storage.load()).pending.map((m) => m.id)).toEqual([3]);
    expect(client.pendingCount).toBe(1);
    expect(client.view().get(`ticket/${A}`)).toMatchObject({ title: 'second', status: 'in_progress' });
    expect(transport.callsOf('push')).toHaveLength(1); // 3 was already answered; it waits for its pull
  });
});

import { randomUUID } from 'crypto';
import {
  MemoryStorage,
  MutationRejected,
  SyncClient,
  TransportError,
  deriveStatus,
  type Cursor,
  type SyncFacts,
  type SyncStorage,
} from '../../src';
import { ScriptedTransport, deferred, emptyPull, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const create = (title: string, id = randomUUID()) => ({ id, siteId: SITE, title, description: '' });

describe('client facts and view', () => {
  const clients: SyncClient[] = [];
  const open = (opts: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) => {
    const c = new SyncClient({ transport: new ScriptedTransport(), storage: new MemoryStorage(), env: {}, ...opts });
    clients.push(c);
    return c;
  };
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
    jest.restoreAllMocks();
  });

  it('reports the phase of a sync, and the connection from the last request', async () => {
    const held = deferred<ReturnType<typeof emptyPull>>();
    const transport = new ScriptedTransport()
      .replyPush(new TransportError('network'), { results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      .replyPull(held.promise);
    const client = open({ transport });
    await client.ready;
    const seen: SyncFacts[] = [];
    client.subscribe(() => {
      if (seen[seen.length - 1] !== client.facts) seen.push(client.facts);
    });

    await client.mutate('ticket.create', create('a'));
    await flush();
    expect(client.facts).toMatchObject({ connection: 'offline', phase: 'idle', pendingCount: 1 });
    expect(deriveStatus(client.facts)).toBe('offline');

    void client.sync();
    await flush();
    expect(client.facts).toMatchObject({ connection: 'online', phase: 'pulling' });
    held.resolve(emptyPull(1));
    await flush();
    expect(client.facts).toMatchObject({ connection: 'online', phase: 'idle', pendingCount: 0 });
    expect(deriveStatus(client.facts)).toBe('synced');
    expect(seen.map((f) => f.phase)).toEqual(expect.arrayContaining(['pushing', 'pulling', 'idle']));
  });

  it('keeps the same facts object until a fact changes', async () => {
    const client = open();
    await client.ready;
    const before = client.facts;
    client.subscribe(() => undefined);
    expect(client.facts).toBe(before);
    await client.mutate('ticket.create', create('a'));
    expect(client.facts).not.toBe(before);
    expect(client.facts.pendingCount).toBe(1);
  });

  it('recomputes view and rows only when the data changed', async () => {
    const client = open();
    await client.ready;
    await client.mutate('ticket.create', create('a'));
    const view = client.view();
    const rows = client.rows('ticket');
    expect(client.view()).toBe(view);
    expect(client.rows('ticket')).toBe(rows);
    expect(client.rows('part')).toEqual([]);

    await client.mutate('ticket.create', create('b'));
    expect(client.view()).not.toBe(view);
    expect(client.rows('ticket').map((r) => r.title).sort()).toEqual(['a', 'b']);
  });

  it('keeps the view when a mutation is stored, and the data version when a pull changed nothing', async () => {
    const transport = new ScriptedTransport()
      .alwaysPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      .alwaysPull(emptyPull(null));
    const client = open({ transport });
    await client.ready;
    const stored = client.mutate('ticket.create', create('a'));
    const view = client.view();
    await stored;
    expect(client.view()).toBe(view);
    expect(client.pending[0].id).toBe(1);

    await client.sync();
    const version = client.snapshotVersion;
    const pulls = transport.callsOf('pull').length;
    await client.sync();
    expect(transport.callsOf('pull')).toHaveLength(pulls + 1);
    expect(client.snapshotVersion).toBe(version);
    expect(client.view()).toBe(view);
  });

  it('refuses a mutation that cannot apply to what the user sees, and queues nothing', async () => {
    const storage = new MemoryStorage();
    const client = open({ storage });
    await client.ready;
    const id = randomUUID();
    await client.mutate('ticket.create', create('a', id));
    const partId = randomUUID();
    await client.mutate('part.add', { id: partId, ticketId: id, name: 'filter', quantity: 1 });

    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof MutationRejected ? err.code : err;
      }
      return 'accepted';
    };
    expect(refused(() => client.mutate('ticket.setStatus', { id, from: 'done', to: 'open' }))).toBe('STATUS_CONFLICT');
    expect(refused(() => client.mutate('part.adjust', { id: partId, delta: -2 }))).toBe('NEGATIVE_QUANTITY');
    expect(refused(() => client.mutate('ticket.update', { id: randomUUID(), patch: { title: 'x' } }))).toBe('NO_ACCESS');
    expect(refused(() => client.mutate('ticket.update', { id, patch: { title: '' } }))).toBe('BAD_ARGS');
    await flush();
    expect(client.pendingCount).toBe(2);
    expect((await storage.load()).pending).toHaveLength(2);
  });

  it('warns once at the warning size and refuses new mutations when the queue is full', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = open({ queueLimits: { warnAt: 2, max: 3 } });
    await client.ready;
    await client.mutate('ticket.create', create('1'));
    expect(warn).not.toHaveBeenCalled();
    await client.mutate('ticket.create', create('2'));
    await client.mutate('ticket.create', create('3'));
    expect(warn).toHaveBeenCalledTimes(1);

    let code: string | undefined;
    try {
      void client.mutate('ticket.create', create('4'));
    } catch (err) {
      code = (err as MutationRejected).code;
    }
    expect(code).toBe('QUEUE_FULL');
    expect(client.pendingCount).toBe(3);
  });

  it('lists the queue: stored mutations in order, then the ones still being stored', async () => {
    const client = open();
    await client.ready;
    await client.mutate('ticket.create', create('a'));
    void client.mutate('ticket.create', create('b'));
    expect(client.pending.map((m) => [m.id, m.args.title])).toEqual([
      [1, 'a'],
      [undefined, 'b'],
    ]);
    await flush();
    expect(client.pending.map((m) => m.id)).toEqual([1, 2]);
  });

  it('falls back to memory when durable storage cannot be opened, and says so', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: SyncStorage = {
      load: () => Promise.reject(new Error('QuotaExceededError')),
      enqueue: () => Promise.reject(new Error('unreachable')),
      commitPull: () => Promise.reject(new Error('unreachable')),
      dismissRejection: () => Promise.reject(new Error('unreachable')),
      resetClient: () => Promise.reject(new Error('unreachable')),
      close: () => undefined,
    };
    const client = open({ storage: broken });
    await client.ready;
    expect(client.facts.storage).toBe('memory');
    expect(error).toHaveBeenCalled();
    await client.mutate('ticket.create', create('kept in memory'));
    expect(client.rows('ticket')).toHaveLength(1);
  });

  it('counts unresolved rejections and drops one when the user dismisses it', async () => {
    const storage = new MemoryStorage();
    await storage.load();
    await storage.enqueue({ name: 'ticket.create', args: create('a'), createdAt: '2026-01-01T10:00:00.000Z' });
    await storage.commitPull({
      expectedCursor: null,
      cursor: 'c1' as Cursor,
      lastMutationId: 1,
      rejections: [{ mutationId: 1, code: 'NO_ACCESS', message: 'Ticket is unavailable' }],
    });
    const client = open({ storage });
    await client.ready;
    expect(client.facts.unresolvedRejections).toBe(1);
    expect(deriveStatus(client.facts)).toBe('rejected');
    expect(client.rejections[0]).toMatchObject({ mutation: { id: 1 }, code: 'NO_ACCESS', message: 'Ticket is unavailable' });

    await client.dismissRejection(client.rejections[0].id);
    expect(client.rejections).toHaveLength(0);
    expect(client.facts.unresolvedRejections).toBe(0);
    expect((await storage.load()).rejections).toHaveLength(0);
  });
});

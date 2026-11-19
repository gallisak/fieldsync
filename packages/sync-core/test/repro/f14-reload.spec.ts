import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient } from '../../src';
import { ScriptedTransport, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';

describe('F14 reload', () => {
  const clients: SyncClient[] = [];
  const open = (storage: MemoryStorage, transport: ScriptedTransport) => {
    const c = new SyncClient({ transport, storage });
    clients.push(c);
    return c;
  };
  const ready = (c: SyncClient) => c.ready;

  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
  });

  it('keeps unsynced mutations across a reload', async () => {
    const storage = new MemoryStorage();
    const a = open(storage, new ScriptedTransport());
    await ready(a);
    await a.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'A', description: '' });
    await a.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'B', description: '' });
    await flush();
    a.dispose();

    const b = open(storage, new ScriptedTransport());
    await ready(b);

    expect(b.pendingCount).toBe(2);
    expect(b.rows('ticket').map((r) => r.title).sort()).toEqual(['A', 'B']);
  });

  it('never reuses a mutation id the server has acknowledged', async () => {
    const storage = new MemoryStorage();
    const first = new ScriptedTransport().replyPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 });
    const a = open(storage, first);
    await ready(a);
    await a.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'before reload', description: '' });
    await flush();
    expect(first.callsOf('push')).toHaveLength(1);
    expect(first.callsOf('pull')).toHaveLength(1);
    a.dispose();

    const second = new ScriptedTransport();
    const b = open(storage, second);
    await ready(b);
    await b.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'after reload', description: '' });
    await flush();

    const seenByServer = Math.max(...first.pushedMutations().map((m) => m.id));
    const created = second.pushedMutations().find((m) => m.args.title === 'after reload');
    expect(created).toBeDefined();
    expect(created!.id).toBeGreaterThan(seenByServer);
  });
});

import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient } from '../../src';
import { ScriptedTransport, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';

describe('F15 two tabs on one storage', () => {
  const clients: SyncClient[] = [];
  const open = (storage: MemoryStorage, transport = new ScriptedTransport()) => {
    const c = new SyncClient({ clientId: 'c1', transport, storage });
    clients.push(c);
    return c;
  };
  const ready = (c: SyncClient) => c.ready;

  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
  });

  it('gives each tab its own mutation ids and keeps both mutations', async () => {
    const storage = new MemoryStorage();
    const tab1 = open(storage);
    const tab2 = open(storage);
    await Promise.all([ready(tab1), ready(tab2)]);
    await Promise.all([
      tab1.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'from tab 1', description: '' }),
      tab2.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'from tab 2', description: '' }),
    ]);
    await flush();

    const transport = new ScriptedTransport();
    const reopened = open(storage, transport);
    await ready(reopened);
    expect(reopened.pendingCount).toBe(2);
    expect(reopened.rows('ticket').map((r) => r.title).sort()).toEqual(['from tab 1', 'from tab 2']);

    await reopened.sync();
    const ids = transport.pushedMutations().map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

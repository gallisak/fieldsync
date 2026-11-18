import { randomUUID } from 'crypto';
import { MemoryStorage, MemoryTabHub, SyncClient, type TabCoordinator, type Transport } from '../../src';
import { FakeServer } from '../support/fake-server';

const SITE = '33333333-3333-4333-8333-333333333333';
const create = (title: string) => ({ id: randomUUID(), siteId: SITE, title, description: '' });

async function eventually(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('several tabs on one storage', () => {
  const clients: SyncClient[] = [];
  const open = (storage: MemoryStorage, transport: Transport, tabs?: TabCoordinator) => {
    const c = new SyncClient({ transport, storage, tabs, env: {} });
    clients.push(c);
    c.start();
    return c;
  };
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
  });

  const mutateInterleaved = (a: SyncClient, b: SyncClient) =>
    Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? b : a).mutate('ticket.create', create(`t${i}`))));
  const idsOneToTwenty = (clientId: string) => Array.from({ length: 20 }, (_, i) => `${clientId}/${i + 1}`);

  it('numbers interleaved mutations of two tabs 1…20; only the leader talks to the server', async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const hub = new MemoryTabHub();
    const leaderTransport = server.transport();
    const followerTransport = server.transport();
    const a = open(storage, leaderTransport, hub.join());
    const b = open(storage, followerTransport, hub.join());
    await Promise.all([a.ready, b.ready]);

    await mutateInterleaved(a, b);
    await eventually(async () => server.applied.length === 20 && (await storage.load()).pending.length === 0, 'all 20 applied and acknowledged');
    await eventually(() => b.pendingCount === 0 && b.rows('ticket').length === 20, 'the follower to show the result');

    const { clientId } = await storage.load();
    expect(server.applied).toEqual(idsOneToTwenty(clientId));
    expect(followerTransport.calls).toBe(0);
    expect(a.rows('ticket')).toHaveLength(20);
    expect(b.facts).toMatchObject({ phase: 'idle', connection: 'online' });
  });

  it("sends a follower's mutation through the idle leader and shows it in every tab", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const hub = new MemoryTabHub();
    const followerTransport = server.transport();
    const a = open(storage, server.transport(), hub.join());
    const b = open(storage, followerTransport, hub.join());
    await Promise.all([a.ready, b.ready]);
    await eventually(() => a.facts.phase === 'idle' && b.facts.phase === 'idle', 'both tabs settled');

    await b.mutate('ticket.create', create('from the follower'));
    await eventually(() => server.applied.length === 1, 'the leader to push it');
    await eventually(() => a.rows('ticket').length === 1 && b.pendingCount === 0, 'both tabs to show it acknowledged');
    expect(followerTransport.calls).toBe(0);
  });

  it('when the leader dies mid-push, the next tab takes over and the server drops the duplicates', async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const hub = new MemoryTabHub();
    let answersLost = false;
    const leaderTransport = server.transport({ holdPush: () => answersLost });
    const followerTransport = server.transport();
    const leaderTab = hub.join();
    const a = open(storage, leaderTransport, leaderTab);
    const b = open(storage, followerTransport, hub.join());
    await Promise.all([a.ready, b.ready]);

    answersLost = true;
    await mutateInterleaved(a, b);
    await eventually(() => server.applied.length > 0, 'the leader to push');
    const appliedByDeadLeader = server.applied.length;
    expect(followerTransport.calls).toBe(0);

    leaderTab.kill();
    a.dispose();
    await eventually(async () => (await storage.load()).pending.length === 0, 'the new leader to finish');
    await eventually(() => b.pendingCount === 0, 'the new leader to show it');

    const { clientId } = await storage.load();
    expect(server.duplicates).toBeGreaterThanOrEqual(appliedByDeadLeader);
    expect(server.applied).toEqual(idsOneToTwenty(clientId));
    expect(server.state.size).toBe(20);
    expect(b.rows('ticket')).toHaveLength(20);
    expect(followerTransport.calls).toBeGreaterThan(0);
  });

  it('stays correct with two leaders at once (no coordination at all)', async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = open(storage, server.transport());
    const b = open(storage, server.transport());
    await Promise.all([a.ready, b.ready]);

    await mutateInterleaved(a, b);
    await eventually(async () => (await storage.load()).pending.length === 0, 'everything acknowledged');
    await Promise.all([a.sync(), b.sync()]);

    const { clientId } = await storage.load();
    expect(server.applied).toEqual(idsOneToTwenty(clientId));
    expect(server.state.size).toBe(20);
    expect(a.rows('ticket')).toHaveLength(20);
    expect(b.rows('ticket')).toHaveLength(20);
  });
});

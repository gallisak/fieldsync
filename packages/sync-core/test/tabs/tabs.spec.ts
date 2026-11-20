import { randomUUID } from 'crypto';
import {
  MemoryStorage,
  MemoryTabHub,
  SyncClient,
  TransportError,
  type SyncStorage,
  type TabCoordinator,
  type Transport,
} from '../../src';
import { FakeServer } from '../support/fake-server';
import { ScriptedTransport } from '../support/scripted-transport';

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
  const open = (storage: SyncStorage, transport: Transport, tabs?: TabCoordinator) => {
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

  it('after the first load, neither tab reads the whole storage again for a pull or for the other tab\'s mutation', async () => {
    const server = new FakeServer();
    const shared = new MemoryStorage();
    const loads = { a: 0, b: 0 };
    const counted = (tab: 'a' | 'b'): SyncStorage => ({
      load: () => {
        loads[tab] += 1;
        return shared.load();
      },
      loadQueue: () => shared.loadQueue(),
      enqueue: (m) => shared.enqueue(m),
      commitPull: (c) => shared.commitPull(c),
      dismissRejection: (id) => shared.dismissRejection(id),
      resetClient: () => shared.resetClient(),
      close: () => undefined,
    });
    const hub = new MemoryTabHub();
    const a = open(counted('a'), server.transport(), hub.join());
    const b = open(counted('b'), server.transport(), hub.join());
    await a.mutate('ticket.create', create('first'));
    await eventually(() => b.pendingCount === 0 && b.rows('ticket').length === 1, 'the first ticket synced in both tabs');
    const settled = { ...loads };

    await mutateInterleaved(a, b);
    await eventually(
      () => [a, b].every((t) => t.pendingCount === 0 && t.rows('ticket').length === 21),
      'both tabs to show all 21 synced tickets',
    );
    expect(server.applied).toHaveLength(21);
    expect(loads).toEqual(settled);
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

  describe('a tab whose durable storage cannot be opened', () => {
    class BrokenStorage extends MemoryStorage {
      load(): never {
        throw new Error('IndexedDB unavailable');
      }
    }
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it.each([
      ['follower', false],
      ['first in line for leadership', true],
    ])('syncs its own changes when it would be the %s', async (_role, brokenFirst) => {
      const server = new FakeServer();
      const hub = new MemoryTabHub();
      const openBroken = () => open(new BrokenStorage(), server.transport(), hub.join());
      const openGood = () => open(new MemoryStorage(), server.transport(), hub.join());
      const first = brokenFirst ? openBroken() : openGood();
      const second = brokenFirst ? openGood() : openBroken();
      const [broken, good] = brokenFirst ? [first, second] : [second, first];
      await Promise.all([broken.ready, good.ready]);
      expect(broken.facts.storage).toBe('memory');

      await broken.mutate('ticket.create', create('kept in memory'));
      await good.mutate('ticket.create', create('kept on disk'));

      await eventually(() => server.applied.length === 2, 'both changes to reach the server');
      await eventually(() => broken.pendingCount === 0 && good.pendingCount === 0, 'both tabs to see them acknowledged');
    });
  });

  it('a leader that is told to update hands leadership to a tab that can still sync', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = new FakeServer();
    const hub = new MemoryTabHub();
    const outdated = new TransportError('http', 426, 'UPGRADE_REQUIRED');
    const old = open(new MemoryStorage(), new ScriptedTransport().alwaysPush(outdated).alwaysPull(outdated), hub.join());
    const current = open(new MemoryStorage(), server.transport(), hub.join());
    await Promise.all([old.ready, current.ready]);

    await eventually(() => old.facts.blocked === 'upgrade', 'the old tab to be told to update');
    await current.mutate('ticket.create', create('from the current tab'));

    await eventually(() => server.applied.length === 1, 'the current tab to push');
    expect(current.facts.blocked).toBeNull();
    jest.restoreAllMocks();
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

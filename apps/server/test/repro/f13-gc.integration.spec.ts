import { HttpTransport, MemoryStorage, SyncClient } from '@fieldsync/sync-core';
import { GcService } from '../../src/gc.service';
import { DEMO, TOKENS, createTicket, listen, liveRows, push, seed, sortById } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F13: GC deletes log rows by age with no retained floor and no signal to clients. A client whose cursor
 * predates the cut silently misses changes, and a brand-new client (cursor 0) replays a log that no longer
 * contains the old entities.
 */
describeDb('F13 change-log GC vs stale and new clients', () => {
  let t: TestApp;
  const clients: SyncClient[] = [];
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(async () => {
    for (const c of clients) c.dispose();
    await t?.close();
  });

  const newClient = (baseUrl: string, clientId: string) => {
    const c = new SyncClient({
      clientId,
      transport: new HttpTransport(baseUrl, TOKENS.admin),
      storage: new MemoryStorage(),
    });
    clients.push(c);
    return c;
  };

  it.failing('brings a stale client and a new client to the server state after GC', async () => {
    const baseUrl = await listen(t.app);
    let mutationId = 0;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        await createTicket(t.http, t.pool, {
          token: TOKENS.admin,
          clientId: 'writer',
          mutationId: ++mutationId,
          siteId: DEMO.siteA,
          title: `F13 first ${i}`,
        }),
      );
    }

    const stale = newClient(baseUrl, 'stale-device');
    await stale.sync();
    expect(stale.rows('ticket')).toHaveLength(10);

    // Ten more changes: seven new tickets and three deletions of tickets the stale client holds.
    for (let i = 0; i < 7; i++) {
      await createTicket(t.http, t.pool, {
        token: TOKENS.admin,
        clientId: 'writer',
        mutationId: ++mutationId,
        siteId: DEMO.siteA,
        title: `F13 second ${i}`,
      });
    }
    const deleted = await push(
      t.http,
      TOKENS.admin,
      'writer',
      ids.slice(0, 3).map((id) => ({ id: ++mutationId, name: 'ticket.delete' as const, args: { id, siteId: DEMO.siteA } })),
    );
    expect(deleted.status).toBeLessThan(300);

    await t.pool.query(`UPDATE change_log SET created_at = now() - interval '30 days'`);
    await t.app.get(GcService).collect();

    const server = sortById(await liveRows(t.pool, 'ticket'));
    expect(server).toHaveLength(14);

    await stale.sync();
    expect(sortById(stale.rows('ticket'))).toEqual(server);

    const fresh = newClient(baseUrl, 'fresh-device');
    await fresh.sync();
    expect(sortById(fresh.rows('ticket'))).toEqual(server);
  });
});

import { HttpTransport, MemoryStorage, SyncClient } from '@fieldsync/sync-core';
import { GcService } from '../../src/gc.service';
import { DEMO, TOKENS, createTicket, listen, liveRows, push, seed, sortById } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

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
        await createTicket(t.http, {
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

    for (let i = 0; i < 7; i++) {
      await createTicket(t.http, {
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
      ids.slice(0, 3).map((id) => ({ id: ++mutationId, name: 'ticket.delete' as const, args: { id } })),
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

describeDb('F13 a new client on a database whose log was collected', () => {
  let t: TestApp;
  let client: SyncClient | undefined;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    await t.pool.query(
      `WITH tickets AS (
         SELECT gen_random_uuid() AS id, gen_random_uuid() AS part_id, g,
                CASE WHEN g % 2 = 0 THEN $1::uuid ELSE $2::uuid END AS site_id
           FROM generate_series(1, 1000) AS g
       ), inserted AS (
         INSERT INTO entities (entity, id, site_id, data, deleted, version)
         SELECT 'ticket', id, site_id,
                jsonb_build_object('id', id, 'siteId', site_id::text, 'title', 'old ' || g, 'description', '',
                                   'status', 'open'),
                false, g
           FROM tickets
       )
       INSERT INTO entities (entity, id, site_id, data, deleted, version)
       SELECT 'part', t.part_id, t.site_id,
              jsonb_build_object('id', t.part_id, 'ticketId', t.id::text, 'siteId', t.site_id::text, 'name', 'belt',
                                 'quantity', 1),
              false, 1000 + t.g
         FROM tickets t`,
      [DEMO.siteA, DEMO.siteB],
    );
    await t.pool.query(`UPDATE sync_state SET last_version = 2000, min_retained_version = 2000`);
  });
  afterAll(async () => {
    client?.dispose();
    await t?.close();
  });

  it('gets all 2 000 entities', async () => {
    client = new SyncClient({
      transport: new HttpTransport(await listen(t.app), TOKENS.admin),
      storage: new MemoryStorage(),
    });
    await client.sync();

    expect(client.rows('ticket').length + client.rows('part').length).toBe(2000);
    expect(sortById(client.rows('ticket'))).toEqual(sortById(await liveRows(t.pool, 'ticket')));
    expect(sortById(client.rows('part'))).toEqual(sortById(await liveRows(t.pool, 'part')));
  });
});

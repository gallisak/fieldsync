import { randomUUID } from 'crypto';
import { DEMO, TOKENS, createTicket, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F2 lastMutationId vs paged changes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    await t.pool.query(`UPDATE sync_state SET last_version = 600`);
    await t.pool.query(
      `WITH rows AS (
         SELECT gen_random_uuid() AS id, g FROM generate_series(1, 600) AS g
       ), log AS (
         INSERT INTO change_log (version, tx_seq, site_id, entity, entity_id, op, data)
         SELECT g, g, $1::uuid, 'ticket', id,
                'put', jsonb_build_object('id', id, 'siteId', $1::text, 'title', 'seed ' || g,
                                          'description', '', 'status', 'open')
           FROM rows ORDER BY g
         RETURNING version, entity_id, data
       )
       INSERT INTO entities (entity, id, site_id, data, deleted, version)
       SELECT 'ticket', entity_id, $1::uuid, data, false, version FROM log`,
      [DEMO.siteA],
    );
  });
  afterAll(() => t?.close());

  it('does not acknowledge a mutation on a page that lacks its changes', async () => {
    const created = await push(t.http, TOKENS.admin, 'c1', [
      {
        id: 1,
        name: 'ticket.create',
        args: {
          id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
          siteId: DEMO.siteA,
          title: 'created by mutation 1',
          description: '',
        },
      },
    ]);
    expect(created.body.results[0].status).toBe('applied');

    const page1 = await pull(t.http, TOKENS.admin, { clientId: 'c1', limit: 500 });
    expect(page1.status).toBe(200);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.changes.some((c: { data?: { title?: string } }) => c.data?.title === 'created by mutation 1')).toBe(
      false,
    );
    expect(page1.body.lastMutationId ?? 0).toBeLessThan(1);
  });

  it('does not split a mutation across delta pages', async () => {
    const ticket = await createTicket(t.http, { token: TOKENS.admin, clientId: 'mover', mutationId: 1, siteId: DEMO.siteA, title: 'm' });
    const parts = [randomUUID(), randomUUID(), randomUUID()];
    await push(
      t.http,
      TOKENS.admin,
      'mover',
      parts.map((id, i) => ({ id: i + 2, name: 'part.add' as const, args: { id, ticketId: ticket, name: 'p', quantity: 1 } })),
    );
    let cursor: string | undefined;
    for (let more = true; more; ) {
      const res = await pull(t.http, TOKENS.admin, { cursor, limit: 500 });
      cursor = res.body.cursor;
      more = res.body.hasMore || res.body.mode === 'snapshot';
    }

    await push(t.http, TOKENS.admin, 'mover', [{ id: 5, name: 'ticket.move', args: { id: ticket, toSiteId: DEMO.siteB } }]);
    const page = await pull(t.http, TOKENS.admin, { cursor, limit: 3 });

    expect(page.body.mode).toBe('delta');
    expect(page.body.changes).toHaveLength(8);
    expect(new Set(page.body.changes.map((c: { id: string }) => c.id))).toEqual(new Set([ticket, ...parts]));
  });
});

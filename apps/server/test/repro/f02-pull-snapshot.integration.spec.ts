import { DEMO, TOKENS, createTicket, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F2: pull reports the client's lastMutationId on every page, even when the changes produced by that
 * mutation are on a later page. The client then drops the pending mutation while `base` still lacks its
 * effect.
 */
describeDb('F2 lastMutationId vs paged changes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    // Seeded into both tables so the page-1 assertion still holds once the initial pull becomes a snapshot.
    // Versions 1..600 are taken here, so the allocator must continue after them.
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

  it.failing('does not acknowledge a mutation on a page that lacks its changes', async () => {
    await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'c1',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'created by mutation 1',
    });

    const page1 = await pull(t.http, TOKENS.admin, { clientId: 'c1', limit: 500 });
    expect(page1.status).toBe(200);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.changes.some((c: { data?: { title?: string } }) => c.data?.title === 'created by mutation 1')).toBe(
      false,
    );
    expect(page1.body.lastMutationId ?? 0).toBeLessThan(1);
  });
});

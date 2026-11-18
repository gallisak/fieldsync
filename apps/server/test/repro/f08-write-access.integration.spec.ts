import { randomUUID } from 'crypto';
import { DEMO, TOKENS, createTicket, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F8: write authorization checks the `siteId` the client put in the arguments, before any row is loaded.
 * A technician of site A can change, extend or delete a site-B ticket by sending their own site id.
 */
describeDb('F8 write access is checked against the real row', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('rejects writes to another site even when the client claims its own site', async () => {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'admin',
      mutationId: 1,
      siteId: DEMO.siteB,
      title: 'F8 site-B ticket',
    });
    const before = await t.pool.query(`SELECT data, deleted FROM entities WHERE entity = 'ticket' AND id = $1`, [
      ticketId,
    ]);
    const partId = randomUUID();

    const res = await push(t.http, TOKENS.techA, 'tech-a', [
      { id: 1, name: 'ticket.update', args: { id: ticketId, siteId: DEMO.siteA, patch: { title: 'hijacked' } } },
      {
        id: 2,
        name: 'part.add',
        args: { id: partId, ticketId, siteId: DEMO.siteA, name: 'planted', quantity: 1 },
      },
      { id: 3, name: 'ticket.delete', args: { id: ticketId, siteId: DEMO.siteA } },
    ]);

    expect(res.body.results?.map((r: { status: string }) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(res.body.results?.map((r: { code?: string }) => r.code)).toEqual(['NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS']);

    const after = await t.pool.query(`SELECT data, deleted FROM entities WHERE entity = 'ticket' AND id = $1`, [
      ticketId,
    ]);
    expect(after.rows).toEqual(before.rows);
    const parts = await t.pool.query(`SELECT 1 FROM entities WHERE entity = 'part' AND id = $1`, [partId]);
    expect(parts.rowCount).toBe(0);
  });

  it('refuses to create a ticket in, or move one to, a site the user cannot see', async () => {
    const own = await createTicket(t.http, {
      token: TOKENS.techA,
      clientId: 'tech-a-target',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'site-A ticket',
    });
    const fresh = randomUUID();

    const res = await push(t.http, TOKENS.techA, 'tech-a-target', [
      { id: 2, name: 'ticket.create', args: { id: fresh, siteId: DEMO.siteB, title: 'planted', description: '' } },
      { id: 3, name: 'ticket.move', args: { id: own, toSiteId: DEMO.siteB } },
    ]);

    expect(res.body.results?.map((r: { code?: string }) => r.code)).toEqual(['NO_ACCESS', 'NO_ACCESS']);
    const rows = await t.pool.query(`SELECT id, site_id FROM entities WHERE id = ANY($1::uuid[])`, [[own, fresh]]);
    expect(rows.rows).toEqual([{ id: own, site_id: DEMO.siteA }]);
  });

  // A deleted row still belongs to its site: authorization must not skip it.
  it('refuses ticket.create with the id of a ticket of another site, deleted or not', async () => {
    const opts = { token: TOKENS.admin, clientId: 'admin-create', siteId: DEMO.siteB };
    const live = await createTicket(t.http, { ...opts, mutationId: 1, title: 'site-B ticket' });
    const gone = await createTicket(t.http, { ...opts, mutationId: 2, title: 'deleted site-B ticket' });
    await push(t.http, TOKENS.admin, 'admin-create', [{ id: 3, name: 'ticket.delete', args: { id: gone } }]);

    const res = await push(t.http, TOKENS.techA, 'tech-a-create', [
      { id: 1, name: 'ticket.create', args: { id: live, siteId: DEMO.siteA, title: 'mine', description: '' } },
      { id: 2, name: 'ticket.create', args: { id: gone, siteId: DEMO.siteA, title: 'mine', description: '' } },
    ]);

    expect(res.body.results?.map((r: { code?: string }) => r.code)).toEqual(['NO_ACCESS', 'NO_ACCESS']);
    const rows = await t.pool.query(`SELECT id, site_id, deleted FROM entities WHERE id = ANY($1::uuid[])`, [
      [live, gone],
    ]);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { id: live, site_id: DEMO.siteB, deleted: false },
        { id: gone, site_id: DEMO.siteB, deleted: true },
      ]),
    );
  });

  it('answers ALREADY_EXISTS to ticket.create with the id of a deleted ticket instead of reviving it', async () => {
    const gone = await createTicket(t.http, {
      token: TOKENS.techA,
      clientId: 'tech-a-revive',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'deleted site-A ticket',
    });
    await push(t.http, TOKENS.techA, 'tech-a-revive', [{ id: 2, name: 'ticket.delete', args: { id: gone } }]);

    const res = await push(t.http, TOKENS.techA, 'tech-a-revive', [
      { id: 3, name: 'ticket.create', args: { id: gone, siteId: DEMO.siteA, title: 'again', description: '' } },
    ]);

    expect(res.body.results?.[0]).toMatchObject({ status: 'rejected', code: 'ALREADY_EXISTS' });
    const row = await t.pool.query(`SELECT deleted FROM entities WHERE entity = 'ticket' AND id = $1`, [gone]);
    expect(row.rows).toEqual([{ deleted: true }]);
  });
});

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
});

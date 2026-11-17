import { HttpTransport, MemoryStorage, SyncClient, type Mutation } from '@fieldsync/sync-core';
import { DEMO, TOKENS, createTicket, listen, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F12: nothing ever tells a client to drop data it may no longer see. A revoked site's rows stay on the
 * device, and a ticket moved to another site stays in the old site's clients.
 */
describeDb('F12 revocation and site moves reach the client', () => {
  let t: TestApp;
  let client: SyncClient | undefined;
  beforeEach(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterEach(async () => {
    client?.dispose();
    client = undefined;
    await t?.close();
  });

  async function techAClientWithOneTicket(): Promise<{ client: SyncClient; ticketId: string }> {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'admin',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'F12 site-A ticket',
    });
    const c = new SyncClient({
      clientId: 'tech-a-device',
      transport: new HttpTransport(await listen(t.app), TOKENS.techA),
      storage: new MemoryStorage(),
    });
    await c.sync();
    expect(c.rows('ticket').map((r) => r.id)).toEqual([ticketId]);
    return { client: c, ticketId };
  }

  it.failing('removes all rows of a site whose access was revoked', async () => {
    ({ client } = await techAClientWithOneTicket());

    await t.pool.query(`DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2`, [DEMO.techA, DEMO.siteA]);
    await client.sync();

    expect(client.rows('ticket')).toHaveLength(0);
  });

  it.failing('removes a ticket that was moved to a site the client cannot see', async () => {
    let ticketId: string;
    ({ client, ticketId } = await techAClientWithOneTicket());

    const move = { id: 2, name: 'ticket.move', args: { id: ticketId, toSiteId: DEMO.siteB } } as unknown as Mutation;
    await push(t.http, TOKENS.admin, 'admin', [move]);
    const { rows } = await t.pool.query(`SELECT site_id FROM entities WHERE entity = 'ticket' AND id = $1`, [ticketId]);
    expect(rows[0].site_id).toBe(DEMO.siteB);

    await client.sync();
    expect(client.rows('ticket').map((r) => r.id)).not.toContain(ticketId);
  });
});

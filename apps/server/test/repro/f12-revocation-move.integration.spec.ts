import { HttpTransport, MemoryStorage, SyncClient, type Change, type Mutation } from '@fieldsync/sync-core';
import { randomUUID } from 'crypto';
import { DEMO, TOKENS, createTicket, listen, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

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

  it('removes all rows of a site whose access was revoked', async () => {
    ({ client } = await techAClientWithOneTicket());

    await t.pool.query(`DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2`, [DEMO.techA, DEMO.siteA]);
    await client.sync();

    expect(client.rows('ticket')).toHaveLength(0);
  });

  it('removes a ticket that was moved to a site the client cannot see', async () => {
    let ticketId: string;
    ({ client, ticketId } = await techAClientWithOneTicket());

    const move = { id: 2, name: 'ticket.move', args: { id: ticketId, toSiteId: DEMO.siteB } } as unknown as Mutation;
    await push(t.http, TOKENS.admin, 'admin', [move]);
    const { rows } = await t.pool.query(`SELECT site_id FROM entities WHERE entity = 'ticket' AND id = $1`, [ticketId]);
    expect(rows[0].site_id).toBe(DEMO.siteB);

    await client.sync();
    expect(client.rows('ticket').map((r) => r.id)).not.toContain(ticketId);
  });

  it('delivers a move as deletes to the old site, puts to the new one, and both to a client that sees both', async () => {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'admin',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'moving ticket',
    });
    const parts = [randomUUID(), randomUUID()].sort();
    await push(
      t.http,
      TOKENS.admin,
      'admin',
      parts.map((id, i) => ({
        id: 2 + i,
        name: 'part.add' as const,
        args: { id, ticketId, name: `part ${i}`, quantity: 1 },
      })),
    );
    const cursors = {
      techA: (await pull(t.http, TOKENS.techA)).body.cursor,
      techB: (await pull(t.http, TOKENS.techB)).body.cursor,
      admin: (await pull(t.http, TOKENS.admin)).body.cursor,
    };

    await push(t.http, TOKENS.admin, 'admin', [
      { id: 4, name: 'ticket.move', args: { id: ticketId, toSiteId: DEMO.siteB } },
    ]);

    const changes = async (token: string, cursor: string) =>
      ((await pull(t.http, token, { cursor })).body.changes as Change[]).map((c) => [c.id, c.op, c.siteId]);
    const ids = [ticketId, ...parts];
    expect(await changes(TOKENS.techA, cursors.techA)).toEqual(ids.map((id) => [id, 'del', DEMO.siteA]));
    expect(await changes(TOKENS.techB, cursors.techB)).toEqual(ids.map((id) => [id, 'put', DEMO.siteB]));
    expect(await changes(TOKENS.admin, cursors.admin)).toEqual(
      ids.flatMap((id) => [
        [id, 'del', DEMO.siteA],
        [id, 'put', DEMO.siteB],
      ]),
    );
  });
});

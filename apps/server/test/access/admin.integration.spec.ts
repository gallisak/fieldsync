import { PROTOCOL, PROTOCOL_HEADER, type Change } from '@fieldsync/sync-core';
import { DEMO, TOKENS, createTicket, listen, openStream, pull, seed } from '../support/api';
import { tokenHash } from '../../src/auth/token-hash';
import { createTestApp, describeDb, until, type TestApp } from '../support/pg';

describeDb('admin access endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  const call = (method: 'post' | 'delete', path: string, token?: string) => {
    const req = t.http[method](path).set(PROTOCOL_HEADER, String(PROTOCOL));
    return token ? req.set('authorization', `Bearer ${token}`) : req;
  };
  const techBOnA = `/admin/users/${DEMO.techB}/sites/${DEMO.siteA}`;
  const techBSites = async () =>
    (await t.pool.query(`SELECT site_id FROM user_sites WHERE user_id = $1 ORDER BY site_id`, [DEMO.techB])).rows;

  it('refuses everyone but an admin, and checks the ids', async () => {
    expect((await call('post', techBOnA)).status).toBe(401);
    const tech = await call('post', techBOnA, TOKENS.techA);
    expect(tech.status).toBe(403);
    expect(tech.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call('post', `/admin/users/not-a-uuid/sites/${DEMO.siteA}`, TOKENS.admin)).status).toBe(400);
    const unknown = await call(
      'post',
      `/admin/users/${DEMO.techB}/sites/00000000-0000-4000-8000-0000000000ff`,
      TOKENS.admin,
    );
    expect(unknown.status).toBe(404);
    expect(await techBSites()).toEqual([{ site_id: DEMO.siteB }]);
  });

  it('grants and revokes idempotently; the next pull is an access_changed snapshot each time', async () => {
    const ticketA = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'admin',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'site-A ticket',
    });
    const before = await pull(t.http, TOKENS.techB, { clientId: 'tech-b' });
    expect(before.body).toMatchObject({ mode: 'snapshot', reason: 'initial', changes: [] });

    expect((await call('post', techBOnA, TOKENS.admin)).status).toBe(204);
    expect((await call('post', techBOnA, TOKENS.admin)).status).toBe(204);
    expect(await techBSites()).toEqual([{ site_id: DEMO.siteA }, { site_id: DEMO.siteB }]);
    const granted = await pull(t.http, TOKENS.techB, { clientId: 'tech-b', cursor: before.body.cursor });
    expect(granted.body).toMatchObject({ mode: 'snapshot', reason: 'access_changed', hasMore: false });
    expect(granted.body.changes.map((c: Change) => [c.id, c.op, c.siteId])).toEqual([[ticketA, 'put', DEMO.siteA]]);

    const quiet = await pull(t.http, TOKENS.techB, { clientId: 'tech-b', cursor: granted.body.cursor });
    expect(quiet.body).toMatchObject({ mode: 'delta', changes: [] });

    expect((await call('delete', techBOnA, TOKENS.admin)).status).toBe(204);
    expect((await call('delete', techBOnA, TOKENS.admin)).status).toBe(204);
    const revoked = await pull(t.http, TOKENS.techB, { clientId: 'tech-b', cursor: quiet.body.cursor });
    expect(revoked.body).toMatchObject({ mode: 'snapshot', reason: 'access_changed', changes: [] });
  });

  it("pokes the user's open stream after a grant and after a revoke, then for its new sites only", async () => {
    const stream = await openStream(await listen(t.app), { token: TOKENS.techB });
    let mutationId = 0;
    const create = (siteId: string) =>
      createTicket(t.http, { token: TOKENS.admin, clientId: 'admin-2', mutationId: ++mutationId, siteId, title: 'x' });
    try {
      expect(stream.status).toBe(200);
      const pokes = () => stream.received().split('event: poke').length - 1;
      await call('post', techBOnA, TOKENS.admin);
      await until(async () => pokes() === 1, 'a poke after the grant');
      await create(DEMO.siteA);
      await until(async () => pokes() === 2, 'a poke for the granted site');
      await call('delete', techBOnA, TOKENS.admin);
      await until(async () => pokes() === 3, 'a poke after the revoke');
      await create(DEMO.siteA);
      await create(DEMO.siteB);
      await until(async () => pokes() >= 4, 'a poke for its own site');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pokes()).toBe(4);
    } finally {
      stream.req.destroy();
    }
  });

  it('refreshes the open stream also when the ids in the URL are in upper case', async () => {
    const userId = 'abcdef00-0000-4000-8000-0000000000cd';
    await t.pool.query(`INSERT INTO users (id, name, role, token_hash) VALUES ($1, 'Upper', 'technician', $2)`, [
      userId,
      tokenHash('upper-token'),
    ]);
    const stream = await openStream(await listen(t.app), { token: 'upper-token' });
    try {
      expect(stream.status).toBe(200);
      const path = `/admin/users/${userId.toUpperCase()}/sites/${DEMO.siteA.toUpperCase()}`;
      expect((await call('post', path, TOKENS.admin)).status).toBe(204);
      await until(async () => stream.received().includes('event: poke'), 'a poke after the grant');
    } finally {
      stream.req.destroy();
    }
  });
});

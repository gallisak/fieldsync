import { decodeCursor } from '@fieldsync/sync-core';
import { tokenHash } from '../../src/auth/token-hash';
import { ChangeLogRepository } from '../../src/sync/repositories/change-log.repository';
import { DEMO, TOKENS, createTicket, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F9: pull applies the site filter only for `cursor = 0`; every incremental pull returns all sites' changes.
 */
describeDb('F9 read access on every pull path', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('never returns another site to a technician, initial or incremental', async () => {
    const ticket = (mutationId: number, siteId: string, title: string) =>
      createTicket(t.http, { token: TOKENS.admin, clientId: 'admin', mutationId, siteId, title });

    await ticket(1, DEMO.siteA, 'F9 A1');
    await ticket(2, DEMO.siteB, 'F9 B1');

    const initial = await pull(t.http, TOKENS.techA);
    expect(initial.status).toBe(200);

    await ticket(3, DEMO.siteB, 'F9 B2');
    const incremental = await pull(t.http, TOKENS.techA, { cursor: initial.body.cursor });
    expect(incremental.status).toBe(200);

    const sites = (body: { changes: Array<{ siteId: string }> }) => body.changes.map((c) => c.siteId);
    expect(sites(initial.body)).toContain(DEMO.siteA);
    expect(sites(initial.body)).not.toContain(DEMO.siteB);
    expect(sites(incremental.body)).not.toContain(DEMO.siteB);
  });

  it('gives a technician with no sites an empty last page without reading the log', async () => {
    await t.pool.query(`INSERT INTO users (id, name, role, token_hash) VALUES ($1, 'No sites', 'technician', $2)`, [
      '00000000-0000-4000-8000-000000000009',
      tokenHash('no-sites-token'),
    ]);
    await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'admin-2',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'F9 A',
    });
    const log = t.app.get(ChangeLogRepository);
    const after = jest.spyOn(log, 'after');
    const restOfTx = jest.spyOn(log, 'restOfTx');

    const res = await pull(t.http, 'no-sites-token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changes: [], hasMore: false, lastMutationId: 0, rejections: [] });
    const { rows } = await t.pool.query<{ last_version: string }>(`SELECT last_version FROM sync_state`);
    expect(decodeCursor(res.body.cursor)?.v).toBe(Number(rows[0].last_version));
    expect(after).not.toHaveBeenCalled();
    expect(restOfTx).not.toHaveBeenCalled();
  });
});

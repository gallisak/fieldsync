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

  it.failing('never returns another site to a technician, initial or incremental', async () => {
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
});

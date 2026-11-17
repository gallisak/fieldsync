import { DEMO, TOKENS, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F10: `clients.user_id` is stored but never checked. Another user can push under someone else's clientId
 * (burning their ids, so the owner's real mutations become "duplicates") and read their lastMutationId.
 */
describeDb('F10 clientId belongs to one user', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.failing("refuses another user's clientId on push and pull", async () => {
    const own = await push(t.http, TOKENS.techA, 'c1', [
      { id: 1, name: 'ticket.create', args: { siteId: DEMO.siteA, title: 'F10 A', description: '' } },
    ]);
    expect(own.status).toBeLessThan(300);

    const foreign = await push(t.http, TOKENS.techB, 'c1', [
      { id: 2, name: 'ticket.create', args: { siteId: DEMO.siteB, title: 'F10 B', description: '' } },
    ]);
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ code: 'CLIENT_MISMATCH' });

    const peek = await pull(t.http, TOKENS.techB, { clientId: 'c1' });
    expect([0, null, undefined]).toContain(peek.body.lastMutationId);
  });
});

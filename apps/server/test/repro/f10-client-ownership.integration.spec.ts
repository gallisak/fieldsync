import { randomUUID } from 'crypto';
import { DEMO, TOKENS, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F10 clientId belongs to one user', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it("refuses another user's clientId on push and pull", async () => {
    const own = await push(t.http, TOKENS.techA, 'c1', [
      { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteA, title: 'F10 A', description: '' } },
    ]);
    expect(own.status).toBeLessThan(300);

    const foreign = await push(t.http, TOKENS.techB, 'c1', [
      { id: 2, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteB, title: 'F10 B', description: '' } },
    ]);
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ code: 'CLIENT_MISMATCH' });

    const peek = await pull(t.http, TOKENS.techB, { clientId: 'c1' });
    expect([0, null, undefined]).toContain(peek.body.lastMutationId);
  });

  it("does not show another user's rejections", async () => {
    const rejected = await push(t.http, TOKENS.techA, 'c2', [
      { id: 1, name: 'part.adjust', args: { id: randomUUID(), delta: 1 } },
    ]);
    expect(rejected.body.results?.[0]).toMatchObject({ status: 'rejected', code: 'NO_ACCESS' });

    const owner = await pull(t.http, TOKENS.techA, { clientId: 'c2' });
    expect(owner.body).toMatchObject({ lastMutationId: 1, rejections: [{ mutationId: 1, code: 'NO_ACCESS' }] });

    const peek = await pull(t.http, TOKENS.techB, { clientId: 'c2' });
    expect(peek.body).toMatchObject({ lastMutationId: 0, rejections: [] });
  });
});

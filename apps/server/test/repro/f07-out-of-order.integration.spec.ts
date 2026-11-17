import { DEMO, TOKENS, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F7: a mutation id ahead of the server's counter is answered with a generic 400, which the client treats as
 * "offline" and retries unchanged forever. The server must say what it expected so the client can recover.
 */
describeDb('F7 out-of-order mutation id', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.failing('answers 409 OUT_OF_ORDER with the expected id', async () => {
    const res = await push(t.http, TOKENS.admin, 'fresh-client', [
      { id: 5, name: 'ticket.create', args: { siteId: DEMO.siteA, title: 'F7', description: '' } },
    ]);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'OUT_OF_ORDER', details: { expected: 1 } });
  });
});

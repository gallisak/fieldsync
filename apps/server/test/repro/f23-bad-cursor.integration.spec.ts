import { TOKENS, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F23 malformed cursor', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('answers 400 to a cursor it cannot parse', async () => {
    const res = await pull(t.http, TOKENS.admin, { cursor: 'banana' });
    expect(res.status).toBe(400);
  });
});

import { TOKENS, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F23: `Number(cursor) || 0` turns any garbage cursor into a full-history pull instead of an error.
 */
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

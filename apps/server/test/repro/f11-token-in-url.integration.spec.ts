import { TOKENS, listen, openStream, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F11: the SSE stream accepts the bearer token from the query string, which puts it in access logs, proxy
 * logs and browser history; and tokens are stored in plaintext, so a database dump hands out every account.
 */
describeDb('F11 stream token in the URL', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.failing('does not authenticate a stream from ?token=', async () => {
    const stream = await openStream(await listen(t.app), { query: `token=${TOKENS.admin}` });
    stream.req.destroy();
    expect(stream.status).toBe(401);
  });

  it.failing('keeps no token in the database in plaintext', async () => {
    for (const token of Object.values(TOKENS)) {
      const { rows } = await t.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users u WHERE row_to_json(u)::text LIKE '%' || $1 || '%'`,
        [token],
      );
      expect({ token, rows: rows[0].n }).toEqual({ token, rows: 0 });
    }
  });
});

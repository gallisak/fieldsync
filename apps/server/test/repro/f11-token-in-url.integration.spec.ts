import { TOKENS, listen, openStream, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F11: the SSE stream accepts the bearer token from the query string, which puts it in access logs, proxy
 * logs and browser history.
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
});

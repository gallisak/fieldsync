import { TOKENS, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describeDb('F23 malformed cursor', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.each([
    ['not base64', 'banana!'],
    ['base64 of something that is not JSON', b64('banana')],
    ['JSON of the wrong shape', b64(JSON.stringify({ v: 3 }))],
    ['an unknown kind', b64(JSON.stringify({ k: 'x', v: 3, fp: 'f' }))],
    ['a negative version', b64(JSON.stringify({ k: 'd', v: -1, fp: 'f' }))],
    ['a snapshot position that is not an entity and a uuid', b64(JSON.stringify({ k: 's', v: 3, after: ['ticket', 'x'], fp: 'f' }))],
  ])('answers 400 to %s instead of starting from the beginning', async (_label, cursor) => {
    const res = await pull(t.http, TOKENS.admin, { cursor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

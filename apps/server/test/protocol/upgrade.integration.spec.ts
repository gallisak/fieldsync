import { MIN_PROTOCOL, PROTOCOL, PROTOCOL_HEADER } from '@fieldsync/sync-core';
import { DEMO, TOKENS, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

const ENDPOINTS: [string, 'get' | 'post' | 'delete', string][] = [
  ['/me', 'get', '/me'],
  ['push', 'post', '/sync/push'],
  ['pull', 'get', '/sync/pull'],
  ['the stream', 'get', '/sync/stream'],
  ['granting a site', 'post', `/admin/users/${DEMO.techB}/sites/${DEMO.siteA}`],
  ['revoking a site', 'delete', `/admin/users/${DEMO.techB}/sites/${DEMO.siteA}`],
];

describeDb('protocol version', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  const call = (method: 'get' | 'post' | 'delete', path: string, version?: string, token?: string) => {
    // An unguarded stream would answer 200 and never end; the deadline turns that into a failure.
    let req = t.http[method](path).timeout({ deadline: 3_000 });
    if (version !== undefined) req = req.set(PROTOCOL_HEADER, version);
    return token ? req.set('authorization', `Bearer ${token}`) : req;
  };

  describe.each(ENDPOINTS)('%s', (_name, method, path) => {
    it.each([
      ['an old version', '1'],
      ['no header', undefined],
      ['a version newer than the server', String(PROTOCOL + 1)],
      ['a header that is not a number', 'two'],
    ])('answers 426 with the supported range to %s, before authentication', async (_case, version) => {
      for (const token of [TOKENS.admin, undefined, 'not-a-token']) {
        const res = await call(method, path, version, token);
        expect(res.status).toBe(426);
        expect(res.body).toMatchObject({
          code: 'UPGRADE_REQUIRED',
          message: expect.any(String),
          details: { min: MIN_PROTOCOL, current: PROTOCOL },
        });
      }
    });
  });

  it('lets the current version through to authentication', async () => {
    expect((await call('get', '/me', String(PROTOCOL))).status).toBe(401);
    expect((await call('get', '/me', String(PROTOCOL), TOKENS.techA)).status).toBe(200);
  });

  it('does not ask for a version on the health check', async () => {
    expect((await call('get', '/health')).status).toBe(200);
  });
});

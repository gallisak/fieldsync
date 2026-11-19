import { randomUUID } from 'crypto';
import { PROTOCOL, PROTOCOL_HEADER, type Mutation } from '@fieldsync/sync-core';
import { TOKENS, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('push body size', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  const raw = (body: string) =>
    t.http
      .post('/sync/push')
      .set('authorization', `Bearer ${TOKENS.techA}`)
      .set(PROTOCOL_HEADER, String(PROTOCOL))
      .set('content-type', 'application/json')
      .send(body);

  it('accepts the largest batch the protocol allows', async () => {
    const mutations: Mutation[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: 'ticket.update',
      args: {
        id: randomUUID(),
        patch: { title: '\u0001'.repeat(200), description: '\u0001'.repeat(5000), assigneeId: randomUUID() },
      },
    }));
    const res = await push(t.http, TOKENS.techA, 'c-largest', mutations);

    expect(res.status).toBeLessThan(300);
    expect(res.body.results).toHaveLength(100);
  });

  it('answers a body over the limit with 413, not 500', async () => {
    const res = await raw(JSON.stringify({ clientId: 'c-huge', mutations: [], pad: 'x'.repeat(5 * 1024 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const res = await raw('{"clientId":');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

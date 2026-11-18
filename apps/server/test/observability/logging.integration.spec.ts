import { HttpTransport } from '@fieldsync/sync-core';
import { randomUUID } from 'crypto';
import { DEMO, TOKENS, listen, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

type Line = Record<string, unknown> & { req?: { id?: string; headers?: Record<string, string> } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const create = (id: number, siteId: string) => ({
  id,
  name: 'ticket.create' as const,
  args: { id: randomUUID(), siteId, title: `log ${id}`, description: '' },
});

describeDb('structured logs', () => {
  let t: TestApp;
  let logs: Line[];
  beforeEach(async () => {
    logs = [];
    t = await createTestApp({}, { logs });
    await seed(t.pool);
  });
  afterEach(() => t?.close());

  const ofRequest = (id: string) => logs.filter((l) => l.requestId === id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('tags every line of a push with its request, user, client and mutation, and logs no token', async () => {
    const res = await push(t.http, TOKENS.techA, 'log-device', [create(1, DEMO.siteA), create(2, DEMO.siteB)]).set(
      'x-request-id',
      'trace-p71',
    );
    expect(res.status).toBe(201);
    await settle();

    const lines = ofRequest('trace-p71');
    const mutations = lines.filter((l) => l.msg === 'mutation');
    expect(mutations.map((l) => [l.mutationId, l.status, l.code])).toEqual([
      [1, 'applied', undefined],
      [2, 'rejected', 'NO_ACCESS'],
    ]);
    for (const line of mutations) {
      expect(line).toMatchObject({
        userId: DEMO.techA,
        clientId: 'log-device',
        context: 'PushService',
        durationMs: expect.any(Number),
      });
    }
    expect(lines.find((l) => l.msg === 'request completed')).toMatchObject({
      userId: DEMO.techA,
      req: { id: 'trace-p71', headers: { authorization: '[Redacted]' } },
      res: { statusCode: 201 },
    });
    for (const token of Object.values(TOKENS)) {
      expect(logs.filter((l) => JSON.stringify(l).includes(token))).toEqual([]);
    }
  });

  it('takes the request id from the client transport, a new one per request', async () => {
    const transport = new HttpTransport(await listen(t.app), TOKENS.techA);
    await transport.push({ clientId: 'log-device', mutations: [create(1, DEMO.siteA)] });
    await transport.push({ clientId: 'log-device', mutations: [create(2, DEMO.siteA)] });
    await settle();

    const ids = logs.filter((l) => l.msg === 'mutation').map((l) => l.requestId as string);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(id).toMatch(UUID);
      expect(ofRequest(id).find((l) => l.msg === 'request completed')?.req?.headers?.['x-request-id']).toBe(id);
    }
  });

  it.each([
    ['spaces and quotes', 'a b "forged": "line"'],
    ['more than 64 characters', 'x'.repeat(65)],
  ])('replaces a request id with %s', async (_case, odd) => {
    const res = await push(t.http, TOKENS.techA, 'log-device', [create(1, DEMO.siteA)]).set('x-request-id', odd);
    expect(res.status).toBe(201);
    await settle();
    const [line] = logs.filter((l) => l.msg === 'mutation');
    expect(line.requestId).toMatch(UUID);
  });
});

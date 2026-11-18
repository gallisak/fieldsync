import { randomUUID } from 'crypto';
import type { Mutation } from '@fieldsync/sync-core';
import { DEMO, TOKENS, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F6 prototype-property mutator names', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.each(['constructor', '__proto__'])(
    'answers "%s" with 400 or a rejection, and the queue keeps moving',
    async (name) => {
      const clientId = `c-${name}`;
      const bad = { id: 1, name, args: {} } as unknown as Mutation;
      const res = await push(t.http, TOKENS.admin, clientId, [bad]);

      expect(res.status).not.toBe(500);
      if (res.status < 300) expect(res.body.results[0].status).toBe('rejected');
      else expect(res.status).toBe(400);

      const nextId = res.status < 300 ? 2 : 1;
      const next = await push(t.http, TOKENS.admin, clientId, [
        { id: nextId, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteA, title: `after ${name}`, description: '' } },
      ]);
      expect(next.status).toBeLessThan(300);
      expect(next.body.results[0].status).toBe('applied');
    },
  );
});

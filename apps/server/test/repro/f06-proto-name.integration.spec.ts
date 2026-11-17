import type { Mutation } from '@fieldsync/sync-core';
import { DEMO, TOKENS, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F6: the mutator registry is a plain object, so `MUTATORS["constructor"]` and `MUTATORS["__proto__"]` are
 * truthy; `def.reads` is then not a function and the request dies with a TypeError (500). A client can
 * permanently block its own queue with one such name.
 */
describeDb('F6 prototype-property mutator names', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  // `siteId` makes the starter's authorization pass, so the request reaches the registry lookup.
  it.failing.each(['constructor', '__proto__'])(
    'answers "%s" with 400 or a rejection, and the queue keeps moving',
    async (name) => {
      const clientId = `c-${name}`;
      const bad = { id: 1, name, args: { siteId: DEMO.siteA } } as unknown as Mutation;
      const res = await push(t.http, TOKENS.admin, clientId, [bad]);

      expect(res.status).not.toBe(500);
      if (res.status < 300) expect(res.body.results[0].status).toBe('rejected');
      else expect(res.status).toBe(400);

      const nextId = res.status < 300 ? 2 : 1;
      const next = await push(t.http, TOKENS.admin, clientId, [
        { id: nextId, name: 'ticket.create', args: { siteId: DEMO.siteA, title: `after ${name}`, description: '' } },
      ]);
      expect(next.status).toBeLessThan(300);
      expect(next.body.results[0].status).toBe('applied');
    },
  );
});

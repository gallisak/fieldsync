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

  it.each(['constructor', '__proto__', 'toString'])(
    'refuses a push naming "%s" with 400 before it reaches the queue; the client id stays usable',
    async (name) => {
      const clientId = `c-${name}`;
      const bad = { id: 1, name, args: {} } as unknown as Mutation;
      const res = await push(t.http, TOKENS.admin, clientId, [bad]);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      const { rows } = await t.pool.query(`SELECT 1 FROM clients WHERE client_id = $1`, [clientId]);
      expect(rows).toEqual([]);

      const next = await push(t.http, TOKENS.admin, clientId, [
        { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteA, title: `after ${name}`, description: '' } },
      ]);
      expect(next.body.results).toEqual([{ id: 1, status: 'applied' }]);
    },
  );
});

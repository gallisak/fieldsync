import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DEMO, TOKENS, pull, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F1: change_log.version is a bigserial — allocated at INSERT, visible at COMMIT. A transaction that took a
 * lower version but commits later is skipped by any reader whose cursor already moved past it.
 */
describeDb('F1 change order vs commit order', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  const insertChange = (c: PoolClient, id: string) =>
    c.query(
      `INSERT INTO change_log (site_id, entity, entity_id, op, data) VALUES ($1, 'ticket', $2, 'put', $3)`,
      [DEMO.siteA, id, JSON.stringify({ id, siteId: DEMO.siteA, title: id, description: '', status: 'open' })],
    );

  it.failing('delivers a change whose transaction commits after a later-numbered one', async () => {
    const a = await t.pool.connect();
    const b = await t.pool.connect();
    const idA = randomUUID();
    const idB = randomUUID();
    try {
      await a.query('BEGIN');
      await insertChange(a, idA); // lower version, still uncommitted
      await b.query('BEGIN');
      await insertChange(b, idB);
      await b.query('COMMIT');

      const first = await pull(t.http, TOKENS.admin);
      expect(first.status).toBe(200);

      await a.query('COMMIT');
      const second = await pull(t.http, TOKENS.admin, { cursor: first.body.cursor });
      expect(second.status).toBe(200);

      const seen = [...first.body.changes, ...second.body.changes].map((c: { id: string }) => c.id);
      expect(seen).toContain(idB);
      expect(seen).toContain(idA);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

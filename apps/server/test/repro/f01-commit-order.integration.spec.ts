import { randomUUID } from 'crypto';
import request from 'supertest';
import { MutationExecutor } from '../../src/sync/push/mutation-executor';
import { DEMO, TOKENS, listen, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, until, type TestApp } from '../support/pg';

const PAUSE_KEY = 727101;

/**
 * F1: change_log.version came from a sequence — allocated at INSERT, visible at COMMIT. A transaction that
 * took a lower version but commits later is skipped by any reader whose cursor already moved past it.
 */
describeDb('F1 change order vs commit order', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  const create = (title: string) => ({
    id: 1,
    name: 'ticket.create' as const,
    args: { id: randomUUID(), siteId: DEMO.siteA, title, description: '' },
  });

  it('delivers a change whose transaction commits after a later-numbered one', async () => {
    const http = request(await listen(t.app));
    const executor = t.app.get(MutationExecutor);
    let pausedPid: number | undefined;
    executor.hooks.afterWrites = async (c, m) => {
      if (m.args.title !== 'F1 A') return;
      pausedPid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('SELECT pg_advisory_xact_lock($1)', [PAUSE_KEY]);
    };

    const gate = await t.pool.connect();
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [PAUSE_KEY]);

      // A writes its change, then stops before COMMIT.
      const a = create('F1 A');
      const pushA = push(http, TOKENS.admin, 'client-a', [a]).then((r) => r);
      await until(async () => pausedPid !== undefined, 'A to pause');

      // B starts while A is open. It either commits (versions from a sequence) or queues behind A.
      const b = create('F1 B');
      let bDone = false;
      const pushB = push(http, TOKENS.admin, 'client-b', [b]).then((r) => ((bDone = true), r));
      await until(async () => {
        if (bDone) return true;
        const { rows } = await t.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
          [pausedPid],
        );
        return rows[0].n > 0;
      }, 'B to commit or to queue behind A');

      const first = await pull(t.http, TOKENS.admin);
      expect(first.status).toBe(200);

      await gate.query('SELECT pg_advisory_unlock($1)', [PAUSE_KEY]);
      expect((await pushA).status).toBeLessThan(300);
      expect((await pushB).status).toBeLessThan(300);

      const second = await pull(t.http, TOKENS.admin, { cursor: first.body.cursor });
      expect(second.status).toBe(200);

      const seen = [...first.body.changes, ...second.body.changes].map((c: { id: string }) => c.id);
      expect(seen).toContain(b.args.id);
      expect(seen).toContain(a.args.id);
    } finally {
      executor.hooks.afterWrites = undefined;
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
    }
  });
});

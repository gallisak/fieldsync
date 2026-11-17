import { randomUUID } from 'crypto';
import type { Mutation } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { MutationExecutor } from '../../src/sync/push/mutation-executor';
import { DEMO, TOKENS, createTicket, listen, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, until, waitersOn, type TestApp } from '../support/pg';

const RACERS = 50;

/**
 * The protocol's concurrency guarantees, exercised on real Postgres with real parallel HTTP requests:
 * no reader ever skips a change, a mutation applies at most once, rejections survive a lost response,
 * and a mutation that dies half-way leaves nothing behind.
 */
describeDb('concurrency on real Postgres', () => {
  let t: TestApp;
  beforeEach(async () => {
    // Every racing request holds a pooled connection while it waits inside Postgres.
    t = await createTestApp({ DB_POOL_MAX: String(RACERS + 10) });
    await seed(t.pool);
  });
  afterEach(() => t?.close());

  const create = (id: number, title: string, siteId: string = DEMO.siteA): Mutation => ({
    id,
    name: 'ticket.create',
    args: { id: randomUUID(), siteId, title, description: '' },
  });

  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await t.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n;

  const lastMutationId = async (clientId: string): Promise<number | undefined> => {
    const { rows } = await t.pool.query<{ n: string }>(
      `SELECT last_mutation_id AS n FROM clients WHERE client_id = $1`,
      [clientId],
    );
    return rows.length ? Number(rows[0].n) : undefined;
  };

  it('no reader skips a change while 20 clients write in parallel', async () => {
    const http = request(await listen(t.app));
    let writersDone = false;

    const writer = async (w: number): Promise<void> => {
      const siteId = w % 2 === 0 ? DEMO.siteA : DEMO.siteB;
      for (let id = 1; id <= 50; id++) {
        const res = await push(http, TOKENS.admin, `writer-${w}`, [create(id, `w${w} #${id}`, siteId)]);
        if (res.status >= 300 || res.body.results?.[0]?.status !== 'applied') {
          throw new Error(`writer ${w} mutation ${id}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
    };

    const reader = async (): Promise<number[]> => {
      const versions: number[] = [];
      let cursor: string | undefined;
      for (;;) {
        // Read the flag before pulling: only a pull that started after the last commit may end the loop.
        const finished = writersDone;
        const res = await pull(http, TOKENS.admin, { cursor, limit: 7 });
        if (res.status !== 200) throw new Error(`pull: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        versions.push(...res.body.changes.map((c: { version: number }) => c.version));
        cursor = res.body.cursor;
        if (finished && !res.body.hasMore && res.body.changes.length === 0) return versions;
      }
    };

    const writers = Promise.all(Array.from({ length: 20 }, (_, w) => writer(w))).finally(() => {
      writersDone = true;
    });
    const [, seen] = await Promise.all([writers, Promise.all(Array.from({ length: 5 }, reader))]);

    const { rows } = await t.pool.query<{ v: number }>(`SELECT version::int AS v FROM change_log ORDER BY version`);
    const all = rows.map((r) => r.v);
    expect(all).toHaveLength(1000);
    for (const versions of seen) {
      expect(versions.every((v, i) => i === 0 || v > versions[i - 1])).toBe(true);
      expect(versions).toEqual(all);
    }
  }, 120_000);

  describe('identical requests in flight together', () => {
    /**
     * Sends the same push RACERS times at once while the test holds the sync_state row, so every request is
     * inside its transaction (the first one waiting for version allocation, the rest for the client row)
     * before any of them can commit. Returns the result statuses.
     */
    async function race(clientId: string, m: Mutation): Promise<string[]> {
      const http = request(await listen(t.app));
      const blocker = await t.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM sync_state FOR UPDATE');
        const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const inFlight = Promise.all(Array.from({ length: RACERS }, () => push(http, TOKENS.admin, clientId, [m])));
        await until(async () => (await waitersOn(t.pool, rows[0].pid)) >= RACERS, `${RACERS} requests to queue`, 10_000);
        await blocker.query('ROLLBACK');

        const responses = await inFlight;
        for (const r of responses) expect(r.status).toBeLessThan(300);
        return responses.flatMap((r) => r.body.results.map((x: { status: string }) => x.status)).sort();
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    }

    const expected = ['applied', ...Array<string>(RACERS - 1).fill('duplicate')];

    it('part.adjust changes the quantity once', async () => {
      const ticketId = await createTicket(t.http, {
        token: TOKENS.admin,
        clientId: 'setup',
        mutationId: 1,
        siteId: DEMO.siteA,
        title: 'race',
      });
      const partId = randomUUID();
      await push(t.http, TOKENS.admin, 'setup', [
        { id: 2, name: 'part.add', args: { id: partId, ticketId, name: 'filter', quantity: 1 } },
      ]);

      const statuses = await race('racer', { id: 1, name: 'part.adjust', args: { id: partId, delta: 1 } });

      expect(statuses).toEqual(expected);
      const { rows } = await t.pool.query<{ q: number }>(
        `SELECT (data->>'quantity')::int AS q FROM entities WHERE entity = 'part' AND id = $1`,
        [partId],
      );
      expect(rows[0].q).toBe(2);
      expect(await count(`change_log WHERE entity_id = $1`, [partId])).toBe(2);
    }, 30_000);

    it('ticket.create creates exactly one ticket', async () => {
      const m = create(1, 'race create');

      const statuses = await race('creator', m);

      expect(statuses).toEqual(expected);
      expect(await count(`entities WHERE id = $1`, [m.args.id])).toBe(1);
      expect(await count(`change_log WHERE entity_id = $1`, [m.args.id])).toBe(1);
      expect(await lastMutationId('creator')).toBe(1);
    }, 30_000);
  });

  it('a rejection in the middle of a batch survives a lost response', async () => {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'setup',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'before',
    });
    const batch: Mutation[] = [
      create(1, 'created in batch'),
      // The ticket is "open", so a transition declared from "done" is a status conflict.
      { id: 2, name: 'ticket.setStatus', args: { id: ticketId, from: 'done', to: 'in_progress' } },
      { id: 3, name: 'ticket.update', args: { id: ticketId, patch: { title: 'after' } } },
    ];

    await push(t.http, TOKENS.admin, 'lossy', batch); // the response never reaches the client
    const retry = await push(t.http, TOKENS.admin, 'lossy', batch);

    const rejection = { code: 'STATUS_CONFLICT', message: expect.any(String), details: { current: 'open' } };
    expect(retry.body).toEqual({
      results: [
        { id: 1, status: 'duplicate' },
        { id: 2, status: 'duplicate', ...rejection },
        { id: 3, status: 'duplicate' },
      ],
      lastMutationId: 3,
    });

    const pulled = await pull(t.http, TOKENS.admin, { clientId: 'lossy' });
    expect(pulled.body.lastMutationId).toBe(3);
    expect(pulled.body.rejections).toEqual([{ mutationId: 2, ...rejection }]);

    expect(await count(`entities WHERE id = $1`, [batch[0].args.id])).toBe(1);
    const { rows } = await t.pool.query(`SELECT data->>'title' AS title, data->>'status' AS status FROM entities WHERE id = $1`, [
      ticketId,
    ]);
    expect(rows[0]).toEqual({ title: 'after', status: 'open' });
  });

  describe('a mutation that dies between the change_log insert and the entity write', () => {
    let executor: MutationExecutor;
    let logRowsAtFailure: number[];
    beforeEach(async () => {
      executor = t.app.get(MutationExecutor);
      logRowsAtFailure = [];
      await createTicket(t.http, { token: TOKENS.admin, clientId: 'c1', mutationId: 1, siteId: DEMO.siteA, title: 'ok' });
    });
    afterEach(() => {
      executor.hooks.afterLogInsert = undefined;
    });

    /** Arms the hook for mutations titled `title`; `fail` runs after their log rows were inserted. */
    function failAfterLogInsert(title: string, fail: (c: PoolClient) => Promise<void>): void {
      executor.hooks.afterLogInsert = async (c, m) => {
        if (m.args.title !== title) return;
        const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM change_log WHERE entity_id = $1`, [
          m.args.id,
        ]);
        logRowsAtFailure.push(rows[0].n);
        await fail(c);
      };
    }

    it('a crash (connection lost) leaves neither row and does not consume the id', async () => {
      failAfterLogInsert('crash', async (c) => {
        await c.query('SELECT pg_terminate_backend(pg_backend_pid())');
      });
      const m = create(2, 'crash');

      const res = await push(t.http, TOKENS.admin, 'c1', [m]);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'UNAVAILABLE' });
      expect(logRowsAtFailure.length).toBeGreaterThan(1); // retried after each crash
      expect(logRowsAtFailure.every((n) => n === 1)).toBe(true); // the log row did exist inside each attempt
      expect(await count(`change_log WHERE entity_id = $1`, [m.args.id])).toBe(0);
      expect(await count(`entities WHERE id = $1`, [m.args.id])).toBe(0);
      expect(await count(`mutation_rejections WHERE client_id = $1`, ['c1'])).toBe(0);
      expect(await lastMutationId('c1')).toBe(1);

      executor.hooks.afterLogInsert = undefined;
      const again = await push(t.http, TOKENS.admin, 'c1', [m]);
      expect(again.body.results).toEqual([{ id: 2, status: 'applied' }]);
      expect(await count(`change_log WHERE entity_id = $1`, [m.args.id])).toBe(1);
      expect(await count(`entities WHERE id = $1`, [m.args.id])).toBe(1);
    });

    it('an exception rolls back to the savepoint: no row, INTERNAL rejection, the next mutation applies', async () => {
      failAfterLogInsert('bug', async () => {
        throw new Error('executor bug');
      });
      const m = create(2, 'bug');

      const res = await push(t.http, TOKENS.admin, 'c1', [m, create(3, 'next')]);

      expect(res.body.results).toEqual([
        { id: 2, status: 'rejected', code: 'INTERNAL', message: 'Unexpected server error' },
        { id: 3, status: 'applied' },
      ]);
      expect(logRowsAtFailure).toEqual([1]);
      expect(await count(`change_log WHERE entity_id = $1`, [m.args.id])).toBe(0);
      expect(await count(`entities WHERE id = $1`, [m.args.id])).toBe(0);
      expect(await lastMutationId('c1')).toBe(3);
    });
  });
});

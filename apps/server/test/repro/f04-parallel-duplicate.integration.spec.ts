import { randomUUID } from 'crypto';
import request from 'supertest';
import { DEMO, TOKENS, createTicket, listen, push, seed } from '../support/api';
import { createTestApp, describeDb, waitersOn, type TestApp } from '../support/pg';

describeDb('F4 parallel duplicate push', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('applies a mutation once no matter how many identical requests race', async () => {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'setup',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'F4 ticket',
    });
    const partId = randomUUID();
    const added = await push(t.http, TOKENS.admin, 'setup', [
      { id: 2, name: 'part.add', args: { id: partId, ticketId, name: 'filter', quantity: 1 } },
    ]);
    expect(added.status).toBeLessThan(300);

    // Holding the part row makes the race deterministic: every request is inside its transaction before any commits.
    const blocker = await t.pool.connect();
    let responses: request.Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM entities WHERE entity = 'part' AND id = $1 FOR UPDATE`, [partId]);
      const { rows } = await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);

      const http = request(await listen(t.app));
      const adjust = { id: 1, name: 'part.adjust' as const, args: { id: partId, delta: 1 } };
      const inFlight = Promise.all(Array.from({ length: 10 }, () => push(http, TOKENS.admin, 'racer', [adjust])));

      const deadline = Date.now() + 3_000;
      while ((await waitersOn(t.pool, rows[0].pid)) < 10) {
        if (Date.now() > deadline) throw new Error('setup: the 10 requests never queued behind the row lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query('ROLLBACK');
      responses = await inFlight;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const statuses = responses.flatMap((r) => (r.body.results ?? []).map((x: { status: string }) => x.status));
    const { rows } = await t.pool.query<{ quantity: number }>(
      `SELECT (data->>'quantity')::int AS quantity FROM entities WHERE entity = 'part' AND id = $1`,
      [partId],
    );

    expect(rows[0].quantity).toBe(2);
    expect(statuses.filter((s) => s === 'applied')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(9);
  });
});

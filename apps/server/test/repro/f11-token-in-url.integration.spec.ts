import type { LoggerService } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DEMO, TOKENS, listen, openStream, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F11 stream token in the URL', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('does not authenticate a stream from ?token=', async () => {
    const stream = await openStream(await listen(t.app), { query: `token=${TOKENS.admin}` });
    stream.req.destroy();
    expect(stream.status).toBe(401);
  });

  it('keeps no token in the database in plaintext', async () => {
    for (const token of Object.values(TOKENS)) {
      const { rows } = await t.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users u WHERE row_to_json(u)::text LIKE '%' || $1 || '%'`,
        [token],
      );
      expect({ token, rows: rows[0].n }).toEqual({ token, rows: 0 });
    }
  });

  it('never writes a token to the log during a push or a stream connect', async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const logger: LoggerService = {
      log: record,
      error: record,
      warn: record,
      debug: record,
      verbose: record,
      fatal: record,
    };
    const logged = await createTestApp({}, { logger });
    try {
      await seed(logged.pool);
      const res = await push(logged.http, TOKENS.techA, 'f11-log', [
        { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteA, title: 'F11', description: '' } },
      ]);
      expect(res.status).toBe(201);
      const stream = await openStream(await listen(logged.app), { token: TOKENS.techA });
      stream.req.destroy();
      expect(stream.status).toBe(200);
    } finally {
      await logged.close();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const token of Object.values(TOKENS)) expect(lines.filter((l) => l.includes(token))).toEqual([]);
  });
});

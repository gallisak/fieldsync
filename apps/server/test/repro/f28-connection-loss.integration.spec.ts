import { randomBytes, randomUUID } from 'crypto';
import { PROTOCOL, PROTOCOL_HEADER } from '@fieldsync/sync-core';
import { Pool } from 'pg';
import { DEMO, TOKENS } from '../support/api';
import { describeDb, requireDatabaseUrl, until } from '../support/pg';
import { startServerProcess, type ServerProcess } from '../support/server-process';

/**
 * F28: when Postgres drops a pooled connection (restart, failover, an idle timeout in a proxy), node-postgres
 * fails the running query and also emits an 'error' event on the client or the pool. Nothing listened for
 * that event, so the whole server process crashed instead of one request failing over to a new connection.
 * The server runs in its own process here, because inside Jest an uncaught exception is not fatal.
 */
describeDb('F28 lost database connection', () => {
  const name = 'f28_' + randomBytes(6).toString('hex'); // schema and application_name of this test's server
  let admin: Pool;
  let db: Pool; // the server's schema, seen from the test
  let server: ServerProcess | undefined;

  beforeAll(() => {
    admin = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
  });
  afterAll(() => admin?.end());

  beforeEach(async () => {
    await admin.query(`CREATE SCHEMA "${name}"`);
    const url = new URL(requireDatabaseUrl()!);
    url.searchParams.set('options', `-c search_path=${name}`);
    db = new Pool({ connectionString: url.toString(), max: 2 });
    url.searchParams.set('application_name', name);
    server = await startServerProcess({ DATABASE_URL: url.toString(), SEED_DEMO: 'true' });
  });
  afterEach(async () => {
    await server?.stop();
    await db?.end();
    await admin.query(`DROP SCHEMA "${name}" CASCADE`);
  });

  const headers = {
    authorization: `Bearer ${TOKENS.admin}`,
    [PROTOCOL_HEADER]: String(PROTOCOL),
    'content-type': 'application/json',
  };
  const serverBackends = async (where = 'true'): Promise<number[]> => {
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND ${where}`,
      [name],
    );
    return rows.map((r) => r.pid);
  };
  const terminate = (pids: number[]) => admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);

  it.failing('keeps serving after its idle pooled connections are dropped', async () => {
    expect((await fetch(`${server!.url}/sync/pull`, { headers })).status).toBe(200);
    const idle = await serverBackends(`state = 'idle'`);
    expect(idle.length).toBeGreaterThan(0);

    await terminate(idle);
    // Either the process dies (the defect) or it logs the lost connection and carries on.
    await until(async () => !server!.alive() || /connection lost/.test(server!.output()), 'the server to react', 5_000);

    expect(server!.alive()).toBe(true);
    expect((await fetch(`${server!.url}/sync/pull`, { headers })).status).toBe(200);
  });

  it.failing('retries a push whose connection is dropped mid-transaction and applies it once', async () => {
    // Hold the version counter so the push stops inside its transaction, after its writes.
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM sync_state FOR UPDATE');

      const ticketId = randomUUID();
      const pushing = fetch(`${server!.url}/sync/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientId: 'c1',
          mutations: [{ id: 1, name: 'ticket.create', args: { id: ticketId, siteId: DEMO.siteA, title: 'F28', description: '' } }],
        }),
      });
      pushing.catch(() => undefined); // awaited below; a dead server must not also count as an unhandled rejection
      const waiting = () => serverBackends(`wait_event_type = 'Lock'`);
      await until(async () => (await waiting()).length === 1, 'the push to wait inside its transaction');
      const [first] = await waiting();

      await terminate([first]);
      await until(
        async () => !server!.alive() || (await waiting()).some((pid) => pid !== first),
        'the push to be retried on a new connection',
        5_000,
      );
      await blocker.query('ROLLBACK');

      const res = await pushing;
      expect(res.status).toBe(201);
      expect((await res.json()).results).toEqual([{ id: 1, status: 'applied' }]);
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM change_log WHERE entity_id = $1`, [ticketId]);
      expect(rows[0].n).toBe(1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });
});

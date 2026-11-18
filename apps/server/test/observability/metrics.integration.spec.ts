import { randomUUID } from 'crypto';
import { Db } from '../../src/database/db.service';
import { lastMigration } from '../../src/database/migrator';
import { GcService } from '../../src/gc.service';
import { DEMO, TOKENS, listen, openStream, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

const create = (id: number, siteId: string) => ({
  id,
  name: 'ticket.create' as const,
  args: { id: randomUUID(), siteId, title: `metrics ${id}`, description: '' },
});

describeDb('metrics and probes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterEach(() => t?.close());

  const scrape = async () => {
    const res = await t.http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    return (series: string): number => {
      const line = res.text.split('\n').find((l) => l.startsWith(`${series} `));
      return line ? Number(line.slice(series.length + 1)) : 0;
    };
  };

  it('counts a rejected push and a snapshot pull', async () => {
    await push(t.http, TOKENS.admin, 'admin', [create(1, DEMO.siteA), create(2, DEMO.siteA)]);
    const pushed = await push(t.http, TOKENS.techA, 'tech-a', [create(1, DEMO.siteA), create(2, DEMO.siteB)]);
    expect(pushed.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected']);
    let page = (await pull(t.http, TOKENS.techA, { clientId: 'tech-a', limit: 1 })).body;
    expect(page).toMatchObject({ mode: 'snapshot', reason: 'initial', hasMore: true });
    while (page.hasMore) page = (await pull(t.http, TOKENS.techA, { clientId: 'tech-a', cursor: page.cursor, limit: 1 })).body;

    const metric = await scrape();
    expect(metric('fieldsync_mutations_total{status="applied"}')).toBe(3);
    expect(metric('fieldsync_mutations_total{status="rejected"}')).toBe(1);
    expect(metric('fieldsync_mutations_rejected_total{code="NO_ACCESS"}')).toBe(1);
    expect(metric('fieldsync_full_resyncs_total{reason="initial"}')).toBe(1);
    expect(metric('fieldsync_push_duration_seconds_count')).toBe(2);
    expect(metric('fieldsync_pull_duration_seconds_count{mode="snapshot"}')).toBe(3);
  });

  it("observes the delivery lag of other clients' changes only", async () => {
    const first = await pull(t.http, TOKENS.techA, { clientId: 'tech-a' });
    await push(t.http, TOKENS.admin, 'admin', [create(1, DEMO.siteA)]);
    await push(t.http, TOKENS.techA, 'tech-a', [create(1, DEMO.siteA)]);
    const delta = await pull(t.http, TOKENS.techA, { clientId: 'tech-a', cursor: first.body.cursor });
    expect(delta.body).toMatchObject({ mode: 'delta' });
    expect(delta.body.changes).toHaveLength(2);

    const metric = await scrape();
    expect(metric('fieldsync_delivery_lag_seconds_count')).toBe(1);
    expect(metric('fieldsync_pull_duration_seconds_count{mode="delta"}')).toBe(1);
  });

  it('reports open streams and retained log rows, and counts what GC deletes', async () => {
    await push(t.http, TOKENS.admin, 'admin', [create(1, DEMO.siteA), create(2, DEMO.siteB)]);
    const stream = await openStream(await listen(t.app), { token: TOKENS.admin });
    try {
      const metric = await scrape();
      expect(metric('fieldsync_active_streams')).toBe(1);
      expect(metric('fieldsync_change_log_rows')).toBe(2);
    } finally {
      stream.req.destroy();
    }

    await t.pool.query(`UPDATE change_log SET created_at = now() - interval '30 days'`);
    await t.app.get(GcService).collect();
    const metric = await scrape();
    expect(metric('fieldsync_gc_deleted_rows_total')).toBe(2);
    expect(metric('fieldsync_change_log_rows')).toBe(0);
  });

  it('answers /health while alive, and /ready only with the database up and migrated', async () => {
    expect((await t.http.get('/health')).body).toEqual({ status: 'ok' });
    const ready = await t.http.get('/ready');
    expect([ready.status, ready.body]).toEqual([200, { status: 'ready' }]);

    jest.spyOn(t.app.get(Db).pool, 'query').mockRejectedValueOnce(new Error('connection refused') as never);
    expect((await t.http.get('/ready')).status).toBe(503);

    await t.pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [await lastMigration()]);
    const behind = await t.http.get('/ready');
    expect([behind.status, behind.body]).toEqual([503, { status: 'not ready' }]);
  });
});

describeDb('metrics behind METRICS_TOKEN', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ METRICS_TOKEN: 'scrape-secret' });
  });
  afterAll(() => t?.close());

  it('requires the token', async () => {
    expect((await t.http.get('/metrics')).status).toBe(401);
    expect((await t.http.get('/metrics').set('authorization', 'Bearer wrong')).status).toBe(401);
    expect((await t.http.get('/metrics').set('authorization', 'Bearer scrape-secret')).status).toBe(200);
  });
});

import { randomUUID } from 'crypto';
import type { Mutation } from '@fieldsync/sync-core';
import { GcService } from '../../src/gc.service';
import { DEMO, TOKENS, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('GcService.collect', () => {
  let t: TestApp;
  let gc: GcService;
  let seq: number;
  beforeEach(async () => {
    t = await createTestApp();
    await seed(t.pool);
    gc = t.app.get(GcService);
    seq = 0;
  });
  afterEach(() => t?.close());

  const asAdmin = async (name: Mutation['name'], args: Record<string, unknown>) => {
    const res = await push(t.http, TOKENS.admin, 'admin', [{ id: ++seq, name, args }]);
    expect(res.body.results[0].status).toBe('applied');
  };
  const newTicket = async () => {
    const id = randomUUID();
    await asAdmin('ticket.create', { id, siteId: DEMO.siteA, title: 'gc', description: '' });
    return id;
  };
  const backdateLog = (upTo: number) =>
    t.pool.query(`UPDATE change_log SET created_at = now() - interval '30 days' WHERE version <= $1`, [upTo]);
  const logVersions = async () =>
    (await t.pool.query<{ v: number }>(`SELECT version::int AS v FROM change_log ORDER BY version`)).rows.map(
      (r) => r.v,
    );
  const floor = async () =>
    Number((await t.pool.query(`SELECT min_retained_version FROM sync_state`)).rows[0].min_retained_version);

  it('collects the log and the tombstones up to the last version older than the cutoff, and raises the floor', async () => {
    const [t1, t2] = [await newTicket(), await newTicket(), await newTicket()];
    await asAdmin('ticket.delete', { id: t1 });
    await asAdmin('ticket.delete', { id: t2 });
    await backdateLog(4);

    expect(await gc.collect()).toEqual({ cut: 4, log: 4, tombstones: 1, rejections: 0, clients: 0 });
    expect(await logVersions()).toEqual([5]);
    expect(await floor()).toBe(4);
    const { rows } = await t.pool.query(`SELECT id, deleted FROM entities ORDER BY version`);
    expect(rows.map((r) => [r.id, r.deleted])).toEqual([
      [expect.any(String), false],
      [t2, true],
    ]);
  });

  it('changes nothing in the log when no row is older than the cutoff, and never lowers the floor', async () => {
    await newTicket();
    await newTicket();
    expect(await gc.collect()).toMatchObject({ cut: null, log: 0, tombstones: 0 });
    expect(await logVersions()).toEqual([1, 2]);

    await t.pool.query(`UPDATE sync_state SET min_retained_version = 2`);
    await backdateLog(1);
    expect(await gc.collect()).toMatchObject({ cut: 1, log: 1 });
    expect(await floor()).toBe(2);
  });

  it('keeps rejections and clients for CLIENT_RETENTION_DAYS, past the log retention', async () => {
    const pushed = await push(t.http, TOKENS.techA, 'tech-device', [
      { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteB, title: 'x', description: '' } },
    ]);
    expect(pushed.body.results[0]).toMatchObject({ status: 'rejected', code: 'NO_ACCESS' });
    const first = await pull(t.http, TOKENS.techA, { clientId: 'tech-device' });
    await newTicket();
    await backdateLog(1);
    await t.pool.query(`UPDATE mutation_rejections SET created_at = now() - interval '30 days'`);
    await t.pool.query(`UPDATE clients SET last_seen_at = now() - interval '30 days' WHERE client_id = 'tech-device'`);

    expect(await gc.collect()).toMatchObject({ cut: 1, rejections: 0, clients: 0 });
    const late = await pull(t.http, TOKENS.techA, { clientId: 'tech-device', cursor: first.body.cursor });
    expect(late.body).toMatchObject({ mode: 'snapshot', reason: 'cursor_expired', lastMutationId: 1 });
    expect(late.body.rejections.map((r: { mutationId: number; code: string }) => [r.mutationId, r.code])).toEqual([
      [1, 'NO_ACCESS'],
    ]);

    await t.pool.query(`UPDATE mutation_rejections SET created_at = now() - interval '91 days'`);
    await t.pool.query(`UPDATE clients SET last_seen_at = now() - interval '91 days' WHERE client_id = 'tech-device'`);
    expect(await gc.collect()).toMatchObject({ cut: null, rejections: 1, clients: 1 });
  });

  it('does nothing while another run holds the lock', async () => {
    await newTicket();
    await backdateLog(1);
    const other = await t.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(727002, hashtext(current_schema()))');
      expect(await gc.collect()).toBeNull();
      expect(await logVersions()).toEqual([1]);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect(await gc.collect()).toMatchObject({ cut: 1 });
  });
});

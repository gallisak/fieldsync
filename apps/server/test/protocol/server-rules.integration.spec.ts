import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Change } from '@fieldsync/sync-core';
import { parseConfig } from '../../src/config/env';
import { DEMO, TOKENS, createTicket, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('server rules', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterEach(() => t?.close());

  const ticket = (clientId: string, token: string = TOKENS.techA, siteId: string = DEMO.siteA) =>
    createTicket(t.http, { token, clientId, mutationId: 1, siteId, title: 'rules' });
  const first = async (token: string, clientId: string, name: string, args: Record<string, unknown>) =>
    (await push(t.http, token, clientId, [{ id: 2, name, args } as never])).body.results[0];

  it('does not seed again over existing users, so a revoked site stays revoked', async () => {
    await t.pool.query(`DELETE FROM user_sites WHERE user_id = $1`, [DEMO.techA]);
    await seed(t.pool);
    const { rows } = await t.pool.query(`SELECT 1 FROM user_sites WHERE user_id = $1`, [DEMO.techA]);
    expect(rows).toEqual([]);
  });

  it('rejects an assignee who cannot see the ticket, and accepts one who can', async () => {
    const id = await ticket('c1');
    const cannot = await first(TOKENS.techA, 'c1', 'ticket.update', { id, patch: { assigneeId: DEMO.techB } });
    expect(cannot).toMatchObject({ status: 'rejected', code: 'BAD_ARGS' });

    const nobody = await push(t.http, TOKENS.techA, 'c1', [
      { id: 3, name: 'ticket.update', args: { id, patch: { assigneeId: randomUUID() } } },
    ]);
    expect(nobody.body.results[0]).toMatchObject({ status: 'rejected', code: 'BAD_ARGS' });

    const admin = await push(t.http, TOKENS.techA, 'c1', [
      { id: 4, name: 'ticket.update', args: { id, patch: { assigneeId: DEMO.admin } } },
      { id: 5, name: 'ticket.update', args: { id, patch: { assigneeId: DEMO.techA } } },
    ]);
    expect(admin.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied']);
  });

  it('rejects part.add of an id that belongs to a part of another ticket', async () => {
    const one = await ticket('c1');
    const two = await createTicket(t.http, { token: TOKENS.techA, clientId: 'c2', mutationId: 1, siteId: DEMO.siteA, title: 'two' });
    const part = randomUUID();
    expect(await first(TOKENS.techA, 'c1', 'part.add', { id: part, ticketId: one, name: 'belt', quantity: 1 })).toMatchObject({
      status: 'applied',
    });
    expect(await first(TOKENS.techA, 'c2', 'part.add', { id: part, ticketId: two, name: 'belt', quantity: 1 })).toMatchObject({
      status: 'rejected',
      code: 'ALREADY_EXISTS',
    });
  });

  it('keeps a client that only pulls from looking idle', async () => {
    await ticket('puller');
    await t.pool.query(`UPDATE clients SET last_seen_at = now() - interval '30 days' WHERE client_id = 'puller'`);
    await pull(t.http, TOKENS.techA, { clientId: 'puller' });
    const { rows } = await t.pool.query<{ fresh: boolean }>(
      `SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM clients WHERE client_id = 'puller'`,
    );
    expect(rows[0].fresh).toBe(true);
  });

  it('sends every client a snapshot after the epoch changes, as after restoring a backup', async () => {
    await ticket('c1');
    const before = await pull(t.http, TOKENS.techA);
    expect((await pull(t.http, TOKENS.techA, { cursor: before.body.cursor })).body.mode).toBe('delta');

    await t.pool.query(`UPDATE sync_state SET epoch = gen_random_uuid()`);

    const after = await pull(t.http, TOKENS.techA, { cursor: before.body.cursor });
    expect(after.body).toMatchObject({ mode: 'snapshot' });
  });

  it('deletes parts left without a live ticket, through the log', async () => {
    const id = await ticket('c1');
    const orphan = randomUUID();
    await first(TOKENS.techA, 'c1', 'part.add', { id: orphan, ticketId: id, name: 'belt', quantity: 1 });
    await t.pool.query(`UPDATE entities SET deleted = true, data = NULL WHERE entity = 'ticket' AND id = $1`, [id]);
    const cursor = (await pull(t.http, TOKENS.techA)).body.cursor;

    const sql = await readFile(join(__dirname, '../../src/database/migrations/006_orphan_parts.sql'), 'utf8');
    await t.pool.query(sql);

    const { rows } = await t.pool.query(`SELECT deleted FROM entities WHERE entity = 'part' AND id = $1`, [orphan]);
    expect(rows).toEqual([{ deleted: true }]);
    const changes: Change[] = (await pull(t.http, TOKENS.techA, { cursor })).body.changes;
    expect(changes).toEqual([expect.objectContaining({ entity: 'part', id: orphan, op: 'del' })]);
  });
});

describe('configuration bounds', () => {
  const base = { DATABASE_URL: 'postgres://x' };

  it.each([
    ['a timer past what setInterval can hold', { GC_INTERVAL_MS: String(2 ** 31) }],
    ['a heartbeat the client watchdog would not wait for', { STREAM_HEARTBEAT_MS: '60000' }],
    ['clients kept for less time than the log', { CLIENT_RETENTION_DAYS: '1', CHANGELOG_RETENTION_SECONDS: '172800' }],
  ])('refuses %s', (_label, env) => {
    expect(() => parseConfig({ ...base, ...env })).toThrow();
  });

  it('accepts the defaults', () => {
    expect(() => parseConfig(base)).not.toThrow();
  });
});

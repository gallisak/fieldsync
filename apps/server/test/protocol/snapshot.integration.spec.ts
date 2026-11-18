import {
  decodeCursor,
  encodeCursor,
  type Change,
  type CursorData,
  type Mutation,
  type PullResponse,
} from '@fieldsync/sync-core';
import { randomUUID } from 'crypto';
import { DEMO, TOKENS, pull, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

const A = DEMO.siteA;
const B = DEMO.siteB;

describeDb('paged snapshot', () => {
  let t: TestApp;
  let adminSeq: number;
  let techSeq: number;
  beforeEach(async () => {
    t = await createTestApp();
    await seed(t.pool);
    adminSeq = 0;
    techSeq = 0;
  });
  afterEach(() => t?.close());

  const cursorOf = (res: PullResponse): CursorData => decodeCursor(res.cursor)!;
  const pullTech = async (cursor?: string, limit?: number): Promise<PullResponse> => {
    const res = await pull(t.http, TOKENS.techA, { cursor, limit, clientId: 'tech-device' });
    expect(res.status).toBe(200);
    return res.body;
  };
  const send = async (token: string, clientId: string, mutations: Mutation[]) => {
    const res = await push(t.http, token, clientId, mutations);
    expect(res.status).toBe(201);
    return res.body.results as { status: string }[];
  };
  const asAdmin = async (name: Mutation['name'], args: Record<string, unknown>) => {
    const [result] = await send(TOKENS.admin, 'admin', [{ id: ++adminSeq, name, args }]);
    expect(result.status).toBe('applied');
  };
  const asTech = (name: Mutation['name'], args: Record<string, unknown>) =>
    send(TOKENS.techA, 'tech-device', [{ id: ++techSeq, name, args }]);
  const newTicket = async (siteId: string) => {
    const id = randomUUID();
    await asAdmin('ticket.create', { id, siteId, title: 'snapshot', description: '' });
    await asAdmin('part.add', { id: randomUUID(), ticketId: id, name: 'belt', quantity: 1 });
    return id;
  };
  const lastVersion = async () =>
    Number((await t.pool.query(`SELECT last_version FROM sync_state`)).rows[0].last_version);
  const keys = (changes: Change[]) => changes.map((c) => `${c.entity}/${c.id}`);
  const liveKeys = async (sites: string[]) =>
    (
      await t.pool.query<{ key: string }>(
        `SELECT entity || '/' || id AS key FROM entities
          WHERE site_id = ANY($1::uuid[]) AND NOT deleted ORDER BY entity, id`,
        [sites],
      )
    ).rows.map((r) => r.key);

  it('pages every live row of the sites in key order, pinned at one version; reason first, acks last', async () => {
    for (let i = 0; i < 3; i++) await newTicket(A);
    await newTicket(B);
    const [own] = await asTech('ticket.create', { id: randomUUID(), siteId: A, title: 'mine', description: '' });
    expect(own.status).toBe('applied');
    const v = await lastVersion();

    const pages: PullResponse[] = [await pullTech(undefined, 3)];
    while (pages[pages.length - 1].hasMore) pages.push(await pullTech(pages[pages.length - 1].cursor, 3));

    expect(pages).toHaveLength(3); // 7 rows of site A, 3 per page
    expect(pages.map((p) => [p.mode, p.reason, p.lastMutationId])).toEqual([
      ['snapshot', 'initial', null],
      ['snapshot', undefined, null],
      ['snapshot', undefined, 1],
    ]);
    expect(pages.slice(0, -1).map(cursorOf)).toEqual(
      pages
        .slice(0, -1)
        .map((p) => ({ k: 's', v, after: [p.changes[2].entity, p.changes[2].id], fp: expect.any(String) })),
    );
    expect(cursorOf(pages[2])).toMatchObject({ k: 'd', v });
    expect(keys(pages.flatMap((p) => p.changes))).toEqual(await liveKeys([A]));
  });

  it('does not ack on the last page when the log moved while paging; the delta from the pinned version does', async () => {
    await newTicket(A);
    const ticket = await newTicket(A);
    const v = await lastVersion();
    const first = await pullTech(undefined, 2);

    await asTech('ticket.update', { id: ticket, patch: { title: 'while paging' } });
    await asTech('ticket.create', { id: randomUUID(), siteId: B, title: 'not mine', description: '' }); // NO_ACCESS
    const last = await pullTech(first.cursor, 2);
    expect(last).toMatchObject({ mode: 'snapshot', hasMore: false, lastMutationId: null, rejections: [] });
    expect(cursorOf(last)).toMatchObject({ k: 'd', v });

    const delta = await pullTech(last.cursor);
    expect(delta).toMatchObject({ mode: 'delta', hasMore: false, lastMutationId: 2 });
    expect(delta.rejections.map((r) => [r.mutationId, r.code])).toEqual([[2, 'NO_ACCESS']]);
    expect(delta.changes.map((c) => [c.id, c.data?.title])).toEqual([[ticket, 'while paging']]);
  });

  it('restarts a snapshot when the sites changed or the log was collected while it was paged', async () => {
    await newTicket(A);
    await newTicket(B);
    const first = await pullTech(undefined, 1);

    await t.pool.query(`INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)`, [DEMO.techA, B]);
    const regranted = await pullTech(first.cursor, 1);
    expect(regranted).toMatchObject({ mode: 'snapshot', reason: 'access_changed', hasMore: true });
    expect(keys(regranted.changes)).toEqual((await liveKeys([A, B])).slice(0, 1));

    await newTicket(A);
    await t.pool.query(`UPDATE sync_state SET min_retained_version = last_version`);
    const expired = await pullTech(regranted.cursor, 1);
    expect(expired).toMatchObject({ mode: 'snapshot', reason: 'cursor_expired', hasMore: true });
    expect(cursorOf(expired)).toMatchObject({ k: 's', v: await lastVersion() });
  });

  it('answers a delta cursor below the retained log or beyond the last version with a snapshot', async () => {
    await newTicket(A);
    const { fp } = cursorOf(await pullTech());
    await t.pool.query(`UPDATE sync_state SET min_retained_version = 1`);
    const at = (v: number) => pullTech(encodeCursor({ k: 'd', v, fp }));

    expect(await at(0)).toMatchObject({ mode: 'snapshot', reason: 'cursor_expired' });
    expect(await at(1)).toMatchObject({ mode: 'delta' });
    expect(await at(2)).toMatchObject({ mode: 'delta' });
    expect(await at(3)).toMatchObject({ mode: 'snapshot', reason: 'cursor_ahead' });
  });

  it('answers 400 to a snapshot cursor whose key is not an entity key', async () => {
    const raw = (after: unknown) => Buffer.from(JSON.stringify({ k: 's', v: 0, after, fp: 'x' })).toString('base64url');
    expect((await pull(t.http, TOKENS.techA, { cursor: raw(['ticket', randomUUID()]) })).status).toBe(200);
    for (const after of [['ticket', 'not-a-uuid'], ['site', randomUUID()], ['ticket'], null]) {
      expect((await pull(t.http, TOKENS.techA, { cursor: raw(after) })).status).toBe(400);
    }
  });
});

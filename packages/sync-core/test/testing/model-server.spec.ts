import {
  TransportError,
  decodeCursor,
  encodeCursor,
  type Cursor,
  type Mutation,
  type MutatorName,
  type PullResponse,
} from '../../src';
import { ModelServer, type AuthUser } from '../../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const P1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ADMIN: AuthUser = { id: 'admin', role: 'admin' };
const TECH: AuthUser = { id: 'tech', role: 'technician' };
const OTHER: AuthUser = { id: 'other', role: 'technician' };

function model(): ModelServer {
  const s = new ModelServer();
  s.sites.add(A);
  s.sites.add(B);
  s.grant(TECH.id, A);
  s.grant(OTHER.id, B);
  return s;
}

const m = (id: number, name: MutatorName, args: Record<string, unknown>): Mutation => ({ id, name, args });
const create = (id: number, ticket: string, siteId: string) =>
  m(id, 'ticket.create', { id: ticket, siteId, title: 'title', description: '' });
const pull = (s: ModelServer, user: AuthUser, clientId: string, cursor: Cursor | null = null, limit = 500, acked = 0) =>
  s.pull(user, { cursor, clientId, ackedMutationId: acked, limit });
const fromZero = (s: ModelServer, user: AuthUser): Cursor =>
  encodeCursor({ k: 'd', v: 0, fp: decodeCursor(pull(s, user, 'probe').cursor)!.fp });
const failure = (fn: () => unknown): TransportError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TransportError) return err;
    throw err;
  }
  throw new Error('expected a TransportError');
};

describe('ModelServer', () => {
  it('answers a duplicate with the stored rejection; a rejection does not block the queue', () => {
    const s = model();
    const res = s.push(TECH, {
      clientId: 'c1',
      mutations: [create(1, T1, A), create(2, T2, B), m(3, 'ticket.update', { id: T1, patch: { title: 'new' } })],
    });
    expect(res.results.map((r) => [r.status, r.code])).toEqual([
      ['applied', undefined],
      ['rejected', 'NO_ACCESS'],
      ['applied', undefined],
    ]);
    expect(res.lastMutationId).toBe(3);

    const again = s.push(TECH, { clientId: 'c1', mutations: [create(2, T2, B)] });
    expect(again.results).toEqual([{ id: 2, status: 'duplicate', code: 'NO_ACCESS', message: expect.any(String) }]);
    expect(s.applied).toEqual(['c1/1', 'c1/3']);
  });

  it('aborts the batch on OUT_OF_ORDER or CLIENT_MISMATCH and keeps what came before', () => {
    const s = model();
    const gap = failure(() => s.push(TECH, { clientId: 'c1', mutations: [create(1, T1, A), create(3, T2, A)] }));
    expect(gap).toMatchObject({ status: 409, code: 'OUT_OF_ORDER', details: { expected: 2 } });
    expect(s.applied).toEqual(['c1/1']);

    const theirs = failure(() => s.push(OTHER, { clientId: 'c1', mutations: [create(2, T2, B)] }));
    expect(theirs).toMatchObject({ status: 403, code: 'CLIENT_MISMATCH' });

    expect(failure(() => s.push(TECH, { clientId: 'c2', mutations: [create(2, T2, A)] }))).toMatchObject({
      status: 409,
    });
    expect(s.push(OTHER, { clientId: 'c2', mutations: [create(1, T2, B)] }).results[0].status).toBe('applied');
  });

  it('authorizes on the site stored with the row and on the site a write targets', () => {
    const s = model();
    s.push(ADMIN, { clientId: 'admin', mutations: [create(1, T1, B), create(2, T2, A)] });
    const res = s.push(TECH, {
      clientId: 'c1',
      mutations: [
        m(1, 'ticket.update', { id: T1, patch: { title: 'mine now' } }),
        m(2, 'part.add', { id: P1, ticketId: T1, name: 'filter', quantity: 1 }),
        m(3, 'ticket.move', { id: T2, toSiteId: B }),
        m(4, 'ticket.delete', { id: T1 }),
      ],
    });
    expect(res.results.map((r) => r.code)).toEqual(['NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS']);
    expect(s.lastVersion).toBe(2);
  });

  it('keeps a deleted row in its site and its id taken', () => {
    const s = model();
    s.push(ADMIN, {
      clientId: 'admin',
      mutations: [
        create(1, T1, B),
        m(2, 'ticket.delete', { id: T1 }),
        create(3, T2, A),
        m(4, 'ticket.delete', { id: T2 }),
      ],
    });
    const res = s.push(TECH, { clientId: 'c1', mutations: [create(1, T1, A), create(2, T2, A)] });
    expect(res.results.map((r) => r.code)).toEqual(['NO_ACCESS', 'ALREADY_EXISTS']);
    expect(s.liveRows()).toEqual([]);
  });

  it('logs a move as a delete at the old site and a put at the new one, parts included, in one transaction', () => {
    const s = model();
    s.push(ADMIN, {
      clientId: 'admin',
      mutations: [create(1, T1, A), m(2, 'part.add', { id: P1, ticketId: T1, name: 'filter', quantity: 1 })],
    });
    s.push(ADMIN, { clientId: 'admin', mutations: [m(3, 'ticket.move', { id: T1, toSiteId: B })] });

    expect(s.log.slice(2).map((e) => [e.version, e.txSeq, e.entity, e.op, e.siteId])).toEqual([
      [3, 3, 'ticket', 'del', A],
      [4, 3, 'ticket', 'put', B],
      [5, 3, 'part', 'del', A],
      [6, 3, 'part', 'put', B],
    ]);
    expect(s.entities.get(`ticket/${T1}`)).toMatchObject({ siteId: B, version: 4 });
    expect(pull(s, TECH, 'c1', fromZero(s, TECH)).changes.map((c) => [c.id, c.op])).toEqual([
      [T1, 'put'],
      [P1, 'put'],
      [T1, 'del'],
      [P1, 'del'],
    ]);
    expect(pull(s, OTHER, 'c2', fromZero(s, OTHER)).changes.map((c) => [c.id, c.op])).toEqual([
      [T1, 'put'],
      [P1, 'put'],
    ]);
  });

  it('never splits a transaction across pages; acknowledges and lists rejections only on the last page, to the owner', () => {
    const s = model();
    s.push(TECH, {
      clientId: 'c1',
      mutations: [
        create(1, T1, A),
        m(2, 'part.add', { id: P1, ticketId: T1, name: 'filter', quantity: 1 }),
        m(3, 'part.add', { id: P2, ticketId: T1, name: 'belt', quantity: 1 }),
        m(4, 'part.adjust', { id: P1, delta: -5 }),
        m(5, 'ticket.delete', { id: T1 }),
      ],
    });

    const pages: PullResponse[] = [];
    let cursor = fromZero(s, TECH);
    do {
      pages.push(pull(s, TECH, 'c1', cursor, 1));
      cursor = pages[pages.length - 1].cursor;
    } while (pages[pages.length - 1].hasMore);

    expect(pages.map((p) => p.changes.map((c) => c.version))).toEqual([[1], [2], [3], [4, 5, 6], []]);
    expect(pages.map((p) => p.lastMutationId)).toEqual([null, null, null, null, 5]);
    expect(pages.map((p) => p.rejections.map((r) => [r.mutationId, r.code]))).toEqual([
      [],
      [],
      [],
      [],
      [[4, 'NEGATIVE_QUANTITY']],
    ]);
    expect(pull(s, TECH, 'c1', null, 500, 4).rejections).toEqual([]);
    expect(pull(s, ADMIN, 'c1')).toMatchObject({ lastMutationId: 0, rejections: [] });
  });

  it('filters every pull by the sites the user has now, and refuses a malformed cursor', () => {
    const s = model();
    s.push(ADMIN, { clientId: 'admin', mutations: [create(1, T1, A), create(2, T2, B)] });
    const ids = () => pull(s, TECH, 'c1').changes.map((c) => c.id);
    expect(ids()).toEqual([T1]);
    s.grant(TECH.id, B);
    expect(ids()).toEqual([T1, T2]);
    s.revoke(TECH.id, B);
    expect(ids()).toEqual([T1]);
    expect(failure(() => pull(s, TECH, 'c1', 'not-a-cursor' as Cursor))).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('answers with an access_changed snapshot when the sites changed since the cursor', () => {
    const s = model();
    s.push(ADMIN, { clientId: 'admin', mutations: [create(1, T1, A), create(2, T2, B)] });
    const first = pull(s, TECH, 'c1');
    expect(first).toMatchObject({ mode: 'snapshot', reason: 'initial' });

    s.grant(TECH.id, B);
    const granted = pull(s, TECH, 'c1', first.cursor);
    expect(granted).toMatchObject({ mode: 'snapshot', reason: 'access_changed', hasMore: false });
    expect(granted.changes.map((c) => [c.id, c.op, c.version])).toEqual([
      [T1, 'put', 1],
      [T2, 'put', 2],
    ]);
    expect(pull(s, TECH, 'c1', granted.cursor)).toMatchObject({ mode: 'delta', changes: [] });

    s.revoke(TECH.id, A);
    s.revoke(TECH.id, B);
    expect(pull(s, TECH, 'c1', granted.cursor)).toMatchObject({ mode: 'snapshot', changes: [] });
  });

  it('pages a snapshot in (entity, id) order, pinned at one version; reason on the first page, acks on the last', () => {
    const s = model();
    s.push(TECH, {
      clientId: 'c1',
      mutations: [
        create(1, T2, A),
        create(2, T1, A),
        m(3, 'part.add', { id: P1, ticketId: T1, name: 'f', quantity: 1 }),
      ],
    });
    s.push(OTHER, { clientId: 'c2', mutations: [create(1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0', B)] });

    const first = pull(s, TECH, 'c1', null, 2);
    expect(first).toMatchObject({ mode: 'snapshot', reason: 'initial', hasMore: true, lastMutationId: null });
    expect(first.changes.map((c) => [c.entity, c.id, c.version])).toEqual([
      ['part', P1, 3],
      ['ticket', T1, 2],
    ]);
    expect(decodeCursor(first.cursor)).toMatchObject({ k: 's', v: 4, after: ['ticket', T1] });

    const last = pull(s, TECH, 'c1', first.cursor, 2);
    expect(last).toMatchObject({ mode: 'snapshot', hasMore: false, lastMutationId: 3, rejections: [] });
    expect(last).not.toHaveProperty('reason');
    expect(last.changes.map((c) => c.id)).toEqual([T2]);
    expect(decodeCursor(last.cursor)).toMatchObject({ k: 'd', v: 4 });
  });

  it('does not ack on the last snapshot page when the log moved while paging; the delta after it does', () => {
    const s = model();
    s.push(TECH, { clientId: 'c1', mutations: [create(1, T1, A), create(2, T2, A)] });
    const first = pull(s, TECH, 'c1', null, 1);
    s.push(TECH, {
      clientId: 'c1',
      mutations: [m(3, 'ticket.update', { id: T1, patch: { title: 'changed' } }), m(4, 'ticket.delete', { id: T2 })],
    });

    const last = pull(s, TECH, 'c1', first.cursor, 1);
    expect(last).toMatchObject({ mode: 'snapshot', changes: [], hasMore: false, lastMutationId: null, rejections: [] });
    expect(decodeCursor(last.cursor)).toMatchObject({ k: 'd', v: 2 });
    const delta = pull(s, TECH, 'c1', last.cursor);
    expect(delta).toMatchObject({ mode: 'delta', lastMutationId: 4 });
    expect(delta.changes.map((c) => [c.id, c.op])).toEqual([
      [T1, 'put'],
      [T2, 'del'],
    ]);
  });

  it('restarts a snapshot whose sites changed, or whose log was collected, while it was paged', () => {
    const s = model();
    s.push(ADMIN, { clientId: 'admin', mutations: [create(1, T1, A), create(2, T2, A)] });

    const first = pull(s, TECH, 'c1', null, 1);
    s.grant(TECH.id, B);
    const regranted = pull(s, TECH, 'c1', first.cursor, 1);
    expect(regranted).toMatchObject({ mode: 'snapshot', reason: 'access_changed', hasMore: true });
    expect(regranted.changes.map((c) => c.id)).toEqual([T1]);

    s.push(ADMIN, { clientId: 'admin', mutations: [m(3, 'ticket.update', { id: T2, patch: { title: 'x' } })] });
    s.gc(3);
    const expired = pull(s, TECH, 'c1', regranted.cursor, 1);
    expect(expired).toMatchObject({ mode: 'snapshot', reason: 'cursor_expired', hasMore: true });
    expect(decodeCursor(expired.cursor)).toMatchObject({ k: 's', v: 3, after: ['ticket', T1] });
  });

  it('answers a delta cursor below the retained log or beyond the last version with a snapshot', () => {
    const s = model();
    s.push(TECH, { clientId: 'c1', mutations: [create(1, T1, A), create(2, T2, A)] });
    const { fp } = decodeCursor(fromZero(s, TECH))!;
    s.gc(1);
    expect(pull(s, TECH, 'c1', encodeCursor({ k: 'd', v: 0, fp }))).toMatchObject({
      mode: 'snapshot',
      reason: 'cursor_expired',
    });
    expect(pull(s, TECH, 'c1', encodeCursor({ k: 'd', v: 1, fp }))).toMatchObject({ mode: 'delta' });
    expect(pull(s, TECH, 'c1', encodeCursor({ k: 'd', v: 2, fp }))).toMatchObject({ mode: 'delta' });
    expect(pull(s, TECH, 'c1', encodeCursor({ k: 'd', v: 3, fp }))).toMatchObject({
      mode: 'snapshot',
      reason: 'cursor_ahead',
    });
  });

  it('gc drops the log up to the cut and the tombstones written there', () => {
    const s = model();
    s.push(TECH, {
      clientId: 'c1',
      mutations: [create(1, T1, A), create(2, T2, A), m(3, 'ticket.delete', { id: T1 })],
    });
    s.gc(2);
    expect(s.log.map((e) => e.version)).toEqual([3]);
    expect(s.entities.has(`ticket/${T1}`)).toBe(true);
    s.gc(3);
    expect(s.log).toEqual([]);
    expect([...s.entities.keys()]).toEqual([`ticket/${T2}`]);
    s.gc(1);
    expect(s.minRetained).toBe(3);
  });
});

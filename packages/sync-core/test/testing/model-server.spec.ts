import { TransportError, type Cursor, type Mutation, type MutatorName, type PullResponse } from '../../src';
import { ModelServer, type AuthUser } from '../../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const P1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ADMIN: AuthUser = { id: 'admin', role: 'admin' };
const TECH: AuthUser = { id: 'tech', role: 'technician' }; // site A
const OTHER: AuthUser = { id: 'other', role: 'technician' }; // site B

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

    // A request that failed before any mutation committed leaves no client behind.
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
        m(4, 'ticket.delete', { id: T1 }), // writes no put: only the stored site stops it
      ],
    });
    expect(res.results.map((r) => r.code)).toEqual(['NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS', 'NO_ACCESS']);
    expect(s.lastVersion).toBe(2);
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
    expect(pull(s, TECH, 'c1').changes.map((c) => [c.id, c.op])).toEqual([
      [T1, 'put'],
      [P1, 'put'],
      [T1, 'del'],
      [P1, 'del'],
    ]);
    expect(pull(s, OTHER, 'c2').changes.map((c) => [c.id, c.op])).toEqual([
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
    let cursor: Cursor | null = null;
    do {
      pages.push(pull(s, TECH, 'c1', cursor, 1));
      cursor = pages[pages.length - 1].cursor;
    } while (pages[pages.length - 1].hasMore);

    // Like the real server, `hasMore` is decided before the rest of the transaction is added: an empty last page.
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

  it('gc drops the log up to the cut and the tombstones written there', () => {
    const s = model();
    s.push(TECH, {
      clientId: 'c1',
      mutations: [create(1, T1, A), create(2, T2, A), m(3, 'ticket.delete', { id: T1 })],
    });
    s.gc(2);
    expect(s.log.map((e) => e.version)).toEqual([3]);
    expect(s.entities.has(`ticket/${T1}`)).toBe(true); // its tombstone is version 3
    s.gc(3);
    expect(s.log).toEqual([]);
    expect([...s.entities.keys()]).toEqual([`ticket/${T2}`]);
    s.gc(1);
    expect(s.minRetained).toBe(3);
  });
});

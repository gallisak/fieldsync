import { MemoryStorage, MemoryTabHub, SyncClient, encodeCursor, type Change, type Mutation, type Row } from '../../src';
import {
  ModelServer,
  SimulationFailure,
  checkConvergence,
  checkSafety,
  type At,
  type AuthUser,
  type Device,
} from '../../src/testing';
import { ScriptedTransport } from '../support/scripted-transport';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const P1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TECH: AuthUser = { id: 'tech', role: 'technician' };
const AT: At = { seed: 7, step: 3, trace: Array.from({ length: 40 }, (_, i) => `line ${i}`) };

const MUTATIONS: Mutation[] = [
  { id: 1, name: 'ticket.create', args: { id: T1, siteId: A, title: 'title', description: '' } },
  { id: 2, name: 'part.add', args: { id: P1, ticketId: T1, name: 'filter', quantity: 3 } },
  { id: 3, name: 'part.adjust', args: { id: P1, delta: 2 } },
];

/** Site A holds ticket T1 with part P1 (3 + 2), written by mutations 1–3 of TECH's client `c1`. */
function model(): ModelServer {
  const server = new ModelServer();
  server.sites.add(A);
  server.sites.add(B);
  server.grant(TECH.id, A);
  server.push(TECH, { clientId: 'c1', mutations: MUTATIONS });
  return server;
}

const put = (row: Row, i: number): Change => ({
  version: i + 1,
  entity: 'ticketId' in row ? 'part' : 'ticket',
  id: String(row.id),
  siteId: String(row.siteId),
  op: 'put',
  data: row,
});

const violated = (check: () => void): number | 'none' => {
  try {
    check();
    return 'none';
  } catch (err) {
    if (err instanceof SimulationFailure) return err.invariant;
    throw err;
  }
};

describe('simulation invariants', () => {
  const clients: SyncClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
  });

  /**
   * TECH's device `c1` whose storage holds `rows` at cursor version 5, after the server acknowledged mutations
   * 1 … `acked` (with `rejected` among them); `pending` more mutations are still queued. The queued ones target
   * a ticket that does not exist, so the view skips them and still equals the base.
   */
  async function device(rows: Row[], opts: { acked?: number; rejected?: number[]; pending?: number } = {}) {
    const { acked = 3, rejected = [], pending = 0 } = opts;
    const storage = new MemoryStorage({ idGen: () => 'c1' });
    for (let i = 0; i < acked + pending; i++) {
      await storage.enqueue({ name: 'ticket.update', args: { id: GONE, patch: { title: `t${i}` } }, createdAt: '' });
    }
    await storage.commitPull({
      expectedCursor: null,
      cursor: encodeCursor({ k: 'd', v: 5, fp: 'test' }),
      changes: rows.map(put),
      lastMutationId: acked,
      rejections: rejected.map((mutationId) => ({ mutationId, code: 'NEGATIVE_QUANTITY', message: 'below zero' })),
    });
    const client = new SyncClient({ transport: new ScriptedTransport(), storage, env: {} });
    clients.push(client);
    await client.ready;
    const d: Device = {
      index: 0,
      user: TECH,
      storage,
      hub: new MemoryTabHub(),
      tabs: [client],
      issued: ['c1/1', 'c1/2', 'c1/3'],
      sitesAtLastPull: new Set([A]),
      lastCursorVersion: 0,
      snapshotSinceLastCheck: false,
    };
    return d;
  }

  it('hold for a client that matches the server', async () => {
    const server = model();
    const d = await device(server.liveRows());
    expect(violated(() => checkSafety(server, [d], AT))).toBe('none');
    expect(violated(() => checkConvergence(server, [d], AT))).toBe('none');
  });

  it('name the seed, the step and the invariant, with the last 30 steps', async () => {
    const server = model();
    const d = await device(server.liveRows());
    d.sitesAtLastPull = new Set();
    let message = '';
    try {
      checkSafety(server, [d], AT);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^seed 7, step 3: invariant 1 violated: device 0 holds /);
    expect(message).toMatch(/^line 39$/m);
    expect(message).toMatch(/^line 10$/m);
    expect(message).not.toMatch(/^line 9$/m);
  });

  it('1: a row of a site the user did not have at the last pull', async () => {
    const server = model();
    const d = await device(server.liveRows());
    d.sitesAtLastPull = new Set([B]);
    expect(violated(() => checkSafety(server, [d], AT))).toBe(1);
  });

  it('2: a mutation applied twice', async () => {
    const server = model();
    const d = await device(server.liveRows());
    server.applied.push('c1/2');
    expect(violated(() => checkSafety(server, [d], AT))).toBe(2);
  });

  it('3: a cursor going backwards, unless a snapshot came in between', async () => {
    const server = model();
    const d = await device(server.liveRows());
    d.lastCursorVersion = 9;
    expect(violated(() => checkSafety(server, [d], AT))).toBe(3);
    d.snapshotSinceLastCheck = true;
    expect(violated(() => checkSafety(server, [d], AT))).toBe('none');
    expect(d.lastCursorVersion).toBe(5);
  });

  it('4: a base that differs from the server', async () => {
    const server = model();
    const d = await device(server.liveRows('ticket'));
    expect(violated(() => checkConvergence(server, [d], AT))).toBe(4);
  });

  it('5: a mutation still pending', async () => {
    const server = model();
    const d = await device(server.liveRows(), { pending: 1 });
    expect([...d.tabs[0].view().values()]).toEqual(server.liveRows()); // the queued one changes nothing visible
    expect(violated(() => checkConvergence(server, [d], AT))).toBe(5);
  });

  it('6: an issued mutation that is neither applied nor known as rejected, or both', async () => {
    const server = model();
    server.push(TECH, { clientId: 'c1', mutations: [{ id: 4, name: 'part.adjust', args: { id: P1, delta: -10 } }] });
    const unknown = await device(server.liveRows(), { acked: 4 });
    unknown.issued.push('c1/4');
    expect(violated(() => checkConvergence(server, [unknown], AT))).toBe(6);

    const known = await device(server.liveRows(), { acked: 4, rejected: [4] });
    known.issued.push('c1/4');
    expect(violated(() => checkConvergence(server, [known], AT))).toBe('none');

    const both = await device(server.liveRows(), { acked: 4, rejected: [1, 4] });
    both.issued.push('c1/4');
    expect(violated(() => checkConvergence(server, [both], AT))).toBe(6);
  });

  it('7: a quantity that is not the added quantity plus the applied deltas', async () => {
    const server = model();
    const part = server.entities.get(`part/${P1}`);
    if (part) part.row = { ...part.row, quantity: 4 };
    const d = await device(server.liveRows());
    expect(server.expectedQuantities().get(P1)).toBe(5);
    expect(violated(() => checkConvergence(server, [d], AT))).toBe(7);
  });
});

import type { Cursor, Mutation, PullResponse, PushResponse, TransportError } from '../../src';
import {
  Scheduler,
  SimNetwork,
  int,
  mulberry32,
  uuidFrom,
  type AuthUser,
  type Faults,
  type SyncServerPort,
} from '../../src/testing';

const BATCH = 4;
const CALLS = 120;
const OFFLINE_DEVICE = 2;
const ROUGH: Faults = { dropRequest: 0.12, dropResponse: 0.12, duplicate: 0.12, cut: 0.12, maxDelayMs: 400 };
const NO_FAULTS: Faults = { dropRequest: 0, dropResponse: 0, duplicate: 0, cut: 0, maxDelayMs: 5 };
const USER: AuthUser = { id: 'user', role: 'technician' };

const batch = (): Mutation[] =>
  Array.from({ length: BATCH }, (_, i) => ({ id: i + 1, name: 'ticket.create', args: {} }));
const applied = (mutations: Mutation[]): PushResponse => ({
  results: mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
  lastMutationId: mutations.length,
});
const emptyPull: PullResponse = {
  mode: 'delta',
  changes: [],
  cursor: 'c' as Cursor,
  hasMore: false,
  lastMutationId: 0,
  rejections: [],
};

interface Call {
  device: number;
  kind: 'push' | 'pull';
  offline: boolean;
  served: number[];
  outcome?: string;
}

async function run(seed: number) {
  const rng = mulberry32(seed);
  const s = new Scheduler();
  const trace: string[] = [];
  const calls: Call[] = [];
  const serve = (clientId: string, size: number) => {
    calls[Number(clientId)].served.push(size);
    trace.push(`${s.now} server #${clientId} ${size}`);
  };
  const server: SyncServerPort = {
    push: (_user, req) => {
      serve(req.clientId, req.mutations.length);
      return applied(req.mutations);
    },
    pull: (_user, q) => {
      serve(q.clientId, 0);
      return emptyPull;
    },
  };
  const net = new SimNetwork(rng, s, server, ROUGH);
  const devices = [0, 1, 2].map((i) => net.transportFor(i, { id: `user-${i}`, role: 'technician' }));

  for (let n = 0; n < CALLS; n++) {
    if (n === 40) net.setOffline(OFFLINE_DEVICE, true);
    if (n === 80) net.setOffline(OFFLINE_DEVICE, false);
    const device = int(rng, devices.length);
    const kind = n % 3 === 0 ? 'pull' : 'push';
    const call: Call = { device, kind, offline: n >= 40 && n < 80 && device === OFFLINE_DEVICE, served: [] };
    calls.push(call);
    const clientId = String(n);
    const answer =
      kind === 'pull'
        ? devices[device].pull({ clientId, cursor: null, ackedMutationId: 0, limit: 100 })
        : devices[device].push({ clientId, mutations: batch() });
    void answer.then(
      () => trace.push(`${s.now} device ${device} #${n} ${(call.outcome = 'ok')}`),
      (err: TransportError) => trace.push(`${s.now} device ${device} #${n} ${(call.outcome = err.kind)}`),
    );
    await s.advance(int(rng, 100));
  }
  await s.advance(5_000);
  return { trace, calls };
}

function fate(c: Call): string {
  if (c.offline) return 'offline';
  if (c.served.length === 0) return 'request lost';
  if (c.served.length === 2) return 'duplicated';
  if (c.kind === 'push' && c.served[0] < BATCH) return 'cut';
  return c.outcome === 'ok' ? 'delivered' : 'response lost';
}

describe('simulation kit', () => {
  it('repeats the generator sequence for a seed and draws v4-shaped ids', () => {
    const draws = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
    expect(draws(7)).toEqual(draws(7));
    expect(draws(7)).not.toEqual(draws(8));
    expect(draws(7).every((x) => x >= 0 && x < 1)).toBe(true);
    expect(uuidFrom(mulberry32(1))).toBe(uuidFrom(mulberry32(1)));
    expect(uuidFrom(mulberry32(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("runs due events in (time, insertion) order, each one's promise chain before the next", async () => {
    const s = new Scheduler();
    const seen: string[] = [];
    s.clock.setTimeout(() => seen.push(`b@${s.now}`), 20);
    s.at(10, () => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        seen.push(`a@${s.now}`);
        s.clock.setTimeout(() => seen.push(`a+5@${s.now}`), 5);
      })();
    });
    s.clock.setTimeout(() => seen.push(`c@${s.now}`), 20);
    s.clock.clearTimeout(s.clock.setTimeout(() => seen.push('cleared'), 5));
    s.clock.setTimeout(() => seen.push(`late@${s.now}`), 31);

    await s.advance(30);
    expect(seen).toEqual(['a@10', 'a+5@15', 'b@20', 'c@20']);
    expect(s.now).toBe(30);
    await s.advance(1);
    expect(seen.at(-1)).toBe('late@31');
  });

  it('replays the same fates at the same virtual times for the same seed', async () => {
    const first = await run(42);
    const again = await run(42);
    expect(again.trace).toEqual(first.trace);
    expect(again.calls).toEqual(first.calls);
    expect((await run(43)).trace).not.toEqual(first.trace);

    expect([...new Set(first.calls.map(fate))].sort()).toEqual([
      'cut',
      'delivered',
      'duplicated',
      'offline',
      'request lost',
      'response lost',
    ]);
    for (const c of first.calls.filter((c) => c.offline)) expect(c).toMatchObject({ served: [], outcome: 'network' });
    expect(first.calls.every((c) => c.outcome !== undefined)).toBe(true);
    const answered = first.trace
      .filter((l) => l.includes(' device '))
      .map((l) => Number(l.split('#')[1].split(' ')[0]));
    expect(answered).not.toEqual([...answered].sort((a, b) => a - b));
  });

  it('delivers every call exactly once, promptly, after heal', async () => {
    const s = new Scheduler();
    let served = 0;
    const server: SyncServerPort = {
      push: (_user, req) => {
        served += 1;
        return applied(req.mutations);
      },
      pull: () => emptyPull,
    };
    const net = new SimNetwork(mulberry32(5), s, server, ROUGH);
    net.setOffline(0, true);
    net.heal();
    const t = net.transportFor(0, USER);
    const answers = Array.from({ length: 20 }, (_, i) =>
      t.push({ clientId: 'c', mutations: batch().slice(0, (i % BATCH) + 1) }),
    );
    await s.advance(10);
    await expect(Promise.all(answers)).resolves.toHaveLength(20);
    expect(served).toBe(20);
  });

  it('rejects with the abort reason when the caller gives up; a request already sent still reaches the server', async () => {
    const s = new Scheduler();
    let served = 0;
    const server: SyncServerPort = {
      push: (_user, req) => {
        served += 1;
        return applied(req.mutations);
      },
      pull: () => emptyPull,
    };
    const t = new SimNetwork(mulberry32(1), s, server, NO_FAULTS).transportFor(0, USER);
    const controller = new AbortController();

    const answer = t.push({ clientId: 'c', mutations: batch() }, controller.signal);
    controller.abort(new Error('disposed'));
    await expect(answer).rejects.toThrow('disposed');
    await s.advance(100);
    expect(served).toBe(1);

    await expect(t.push({ clientId: 'c', mutations: batch() }, controller.signal)).rejects.toThrow('disposed');
    await s.advance(100);
    expect(served).toBe(1);
  });
});

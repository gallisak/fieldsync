import { SyncClient } from '../client/sync-client';
import { ALLOWED_TRANSITIONS, MutationRejected } from '../mutators';
import type { Cursor, MutatorName, PullResponse, Row, TicketStatus } from '../protocol/types';
import { MemoryStorage } from '../storage/memory';
import type { PersistedState, PullCommit, QueueState, StoredMutation, SyncStorage } from '../storage/types';
import { MemoryTabHub } from '../tabs/memory';
import type { Transport } from '../transport/http';
import { checkConvergence, checkSafety } from './invariants';
import { ModelServer } from './model-server';
import { chance, int, mulberry32, pick, uuidFrom } from './prng';
import { Scheduler, settle } from './scheduler';
import type { AuthUser, SimServer, SyncServerPort } from './server-port';
import { SimNetwork, type Faults } from './sim-network';

export interface SimConfig {
  seed: number;
  steps: number;
  clients: number;
  faults: Faults;
  /** `forget`: the server drops a quiet client's row, so the client must start over under a new id. */
  flags: { crash: boolean; tabs: boolean; access: boolean; gc: boolean; forget?: boolean };
}

export interface SimOptions {
  /**
   * Defaults to memory. Called once per tab, like a browser tab opening its own connection: the same `name` for
   * every tab of a device, a new one for every device and run. Such a storage never sees `forget`.
   */
  storage?: (name: string, idGen: () => string) => SyncStorage;
}

let runs = 0;

export interface SimReport {
  applied: number;
  rejected: number;
  endTime: number;
  trace: string[];
}

export interface World {
  sites: string[];
  users: AuthUser[];
}

export interface Device {
  index: number;
  user: AuthUser;
  storage: () => SyncStorage;
  hub: MemoryTabHub;
  tabs: SyncClient[];
  /** `clientId/mutationId` of every stored mutation, under the id it is sent with. */
  issued: string[];
  rejected: Set<string>;
  /** The user's sites when the server issued this cursor: what a tab holding it may hold. */
  sitesOf(cursor: Cursor): Set<string> | undefined;
  cursorVersions: WeakMap<SyncClient, number>;
  snapshotSinceLastCheck: boolean;
  violation?: string;
}

export type Action =
  | { kind: 'mutate'; device: number; tab: number; name: MutatorName; args: Record<string, unknown> }
  | { kind: 'advance'; ms: number }
  | { kind: 'partition'; device: number; offline: boolean }
  | { kind: 'crash'; device: number }
  | { kind: 'open-tab'; device: number }
  | { kind: 'close-tab'; device: number; tab: number }
  | { kind: 'grant' | 'revoke'; userId: string; siteId: string }
  | { kind: 'gc'; cut: number }
  | { kind: 'long-offline'; device: number }
  | { kind: 'forget'; device: number };

interface Sim {
  rng: () => number;
  s: Scheduler;
  net: SimNetwork;
  server: SimServer;
  world: World;
  devices: Device[];
  openTab(d: Device): void;
}

const STATUSES: TicketStatus[] = ['open', 'in_progress', 'done', 'cancelled'];

interface Ledger {
  issued: string[];
  rejected: Set<string>;
}

const keyOf = (clientId: string | undefined, id: number) => `${clientId}/${id}`;

// Reads its state synchronously around each call, so it adds no step to the interleaving it observes.
class DeviceStorage extends MemoryStorage {
  constructor(
    idGen: () => string,
    private readonly ledger: Ledger,
  ) {
    super({ idGen });
  }

  override async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const stored = await super.enqueue(m);
    this.ledger.issued.push(keyOf(this.read()?.clientId, stored.id));
    return stored;
  }

  override commitPull(c: PullCommit): Promise<boolean> {
    const before = this.read();
    const result = super.commitPull(c);
    const known = new Set(before?.rejections.map((r) => r.id));
    for (const r of this.read()?.rejections ?? []) {
      if (!known.has(r.id)) this.ledger.rejected.add(keyOf(before?.clientId, r.mutation.id));
    }
    return result;
  }

  override resetClient(): Promise<PersistedState> {
    const before = this.read();
    const result = super.resetClient();
    const after = this.read();
    before?.pending.forEach((m, i) => {
      const at = this.ledger.issued.indexOf(keyOf(before.clientId, m.id));
      if (at >= 0) this.ledger.issued[at] = keyOf(after?.clientId, after?.pending[i].id ?? 0);
    });
    return result;
  }
}

class LedgerStorage implements SyncStorage {
  private clientId?: string;

  constructor(
    private readonly inner: SyncStorage,
    private readonly ledger: Ledger,
  ) {}

  async load(): Promise<PersistedState> {
    const state = await this.inner.load();
    this.clientId = state.clientId;
    return state;
  }

  async loadQueue(): Promise<QueueState> {
    const state = this.inner.loadQueue ? await this.inner.loadQueue() : await this.inner.load();
    this.clientId = state.clientId;
    return state;
  }

  async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const stored = await this.inner.enqueue(m);
    this.clientId ??= (await this.inner.load()).clientId;
    this.ledger.issued.push(keyOf(this.clientId, stored.id));
    return stored;
  }

  async commitPull(c: PullCommit): Promise<boolean> {
    const before = await this.inner.load();
    const ok = await this.inner.commitPull(c);
    if (ok && c.lastMutationId !== null) {
      const pending = new Set(before.pending.map((m) => m.id));
      for (const r of c.rejections) {
        if (r.mutationId <= c.lastMutationId && pending.has(r.mutationId)) {
          this.ledger.rejected.add(keyOf(before.clientId, r.mutationId));
        }
      }
    }
    return ok;
  }

  dismissRejection(id: number): Promise<void> {
    return this.inner.dismissRejection(id);
  }

  resetClient(): Promise<PersistedState> {
    throw new Error('the simulation resets clients only on memory storage');
  }

  onVersionChange(listener: (reason: 'upgrade' | 'deleted') => void): () => void {
    return this.inner.onVersionChange?.(listener) ?? (() => undefined);
  }

  close(): void {
    this.inner.close();
  }
}

async function seedWorld(rng: () => number, server: SimServer): Promise<World> {
  const sites = [uuidFrom(rng), uuidFrom(rng), uuidFrom(rng)];
  for (const site of sites) await server.addSite(site);
  const users: AuthUser[] = [{ id: uuidFrom(rng), role: 'admin' }];
  await server.addUser(users[0]);
  for (let i = 0; i < 4; i++) {
    const user: AuthUser = { id: uuidFrom(rng), role: 'technician' };
    await server.addUser(user);
    const own = sites.filter(() => chance(rng, 0.5));
    for (const site of own.length ? own : [pick(rng, sites)]) await server.grant(user.id, site);
    users.push(user);
  }
  return { sites, users };
}

function drawMutation(sim: Sim, d: Device): Action | undefined {
  const { rng, server, world } = sim;
  const tab = int(rng, d.tabs.length);
  const client = d.tabs[tab];
  const fromServer = chance(rng, 0.1);
  const target = (entity: 'ticket' | 'part'): Row | undefined => {
    const rows = fromServer ? server.liveRows(entity) : client.rows(entity);
    return rows.length ? pick(rng, rows) : undefined;
  };
  const mutate = (name: MutatorName, args: Record<string, unknown>): Action => ({
    kind: 'mutate',
    device: d.index,
    tab,
    name,
    args,
  });

  const roll = int(rng, 100);
  if (roll < 20) {
    const own = [...server.sitesOf(d.user)].sort();
    const siteId = fromServer || own.length === 0 ? pick(rng, world.sites) : pick(rng, own);
    return mutate('ticket.create', { id: uuidFrom(rng), siteId, title: `ticket ${int(rng, 1000)}`, description: '' });
  }
  if (roll < 80) {
    const ticket = target('ticket');
    if (!ticket) return undefined;
    const id = ticket.id as string;
    if (roll < 40) {
      const patch: Record<string, unknown> = {};
      if (chance(rng, 0.5)) patch.title = `title ${int(rng, 1000)}`;
      if (chance(rng, 0.5)) patch.description = `text ${int(rng, 1000)}`;
      if (chance(rng, 0.5)) patch.assigneeId = chance(rng, 0.5) ? null : pick(rng, world.users).id;
      if (Object.keys(patch).length === 0) patch.title = `title ${int(rng, 1000)}`;
      return mutate('ticket.update', { id, patch });
    }
    if (roll < 60) {
      const current = ticket.status as TicketStatus;
      const from = chance(rng, 0.3)
        ? pick(
            rng,
            STATUSES.filter((st) => st !== current),
          )
        : current;
      const allowed = ALLOWED_TRANSITIONS[from];
      const to = allowed.length ? pick(rng, allowed) : pick(rng, STATUSES);
      return mutate('ticket.setStatus', { id, from, to });
    }
    if (roll < 65) return mutate('ticket.delete', { id });
    return mutate('part.add', {
      id: uuidFrom(rng),
      ticketId: id,
      name: `part ${int(rng, 100)}`,
      quantity: 1 + int(rng, 5),
    });
  }
  const part = target('part');
  if (!part) return undefined;
  return mutate('part.adjust', { id: part.id, delta: int(rng, 7) - 3 });
}

function drawMove(sim: Sim): Action | undefined {
  const { rng, world } = sim;
  const admins = sim.devices.filter((d) => d.user.role === 'admin');
  if (admins.length === 0) return undefined;
  const d = pick(rng, admins);
  const tab = int(rng, d.tabs.length);
  const tickets = d.tabs[tab].rows('ticket');
  if (tickets.length === 0) return undefined;
  const ticket = pick(rng, tickets);
  const toSiteId = pick(
    rng,
    world.sites.filter((site) => site !== ticket.siteId),
  );
  return { kind: 'mutate', device: d.index, tab, name: 'ticket.move', args: { id: ticket.id, toSiteId } };
}

const ACTIONS: { weight: number; flag?: keyof SimConfig['flags']; draw(sim: Sim): Action | undefined }[] = [
  { weight: 45, draw: (sim) => drawMutation(sim, pick(sim.rng, sim.devices)) },
  { weight: 20, draw: (sim) => ({ kind: 'advance', ms: int(sim.rng, 5000) }) },
  {
    weight: 10,
    draw: (sim) => {
      const device = int(sim.rng, sim.devices.length);
      return { kind: 'partition', device, offline: !sim.net.isOffline(device) };
    },
  },
  { weight: 6, flag: 'crash', draw: (sim) => ({ kind: 'crash', device: int(sim.rng, sim.devices.length) }) },
  {
    weight: 5,
    flag: 'tabs',
    draw: (sim) => {
      const d = pick(sim.rng, sim.devices);
      return d.tabs.length >= 2
        ? { kind: 'close-tab', device: d.index, tab: int(sim.rng, d.tabs.length) }
        : { kind: 'open-tab', device: d.index };
    },
  },
  {
    weight: 5,
    flag: 'access',
    draw: (sim) => {
      const user = pick(
        sim.rng,
        sim.world.users.filter((u) => u.role === 'technician'),
      );
      const siteId = pick(sim.rng, sim.world.sites);
      return { kind: sim.server.sitesOf(user).has(siteId) ? 'revoke' : 'grant', userId: user.id, siteId };
    },
  },
  { weight: 3, flag: 'access', draw: drawMove },
  { weight: 3, flag: 'gc', draw: (sim) => ({ kind: 'gc', cut: sim.server.lastVersion - int(sim.rng, 20) }) },
  { weight: 3, flag: 'gc', draw: (sim) => ({ kind: 'long-offline', device: int(sim.rng, sim.devices.length) }) },
  { weight: 3, flag: 'forget', draw: drawForget },
];

// Only a client with nothing in flight: forgetting one with an unacknowledged push applies it twice, the
// documented end of deduplication when the client row expires.
function drawForget(sim: Sim): Action | undefined {
  if (!sim.server.forgetClient) return undefined;
  const quiet = sim.devices.filter((d) => d.tabs.length > 0 && d.tabs.every((t) => t.pendingCount === 0));
  return quiet.length ? { kind: 'forget', device: pick(sim.rng, quiet).index } : undefined;
}

function pickAction(sim: Sim, flags: SimConfig['flags']): Action {
  const enabled = ACTIONS.filter((a) => !a.flag || flags[a.flag]);
  const total = enabled.reduce((sum, a) => sum + a.weight, 0);
  for (;;) {
    let r = int(sim.rng, total);
    const entry = enabled.find((a) => (r -= a.weight) < 0) as (typeof enabled)[number];
    const action = entry.draw(sim);
    if (action) return action;
  }
}

async function perform(a: Action, sim: Sim): Promise<void> {
  const { s, net, server, devices } = sim;
  switch (a.kind) {
    case 'mutate':
      try {
        devices[a.device].tabs[a.tab].mutate(a.name, a.args).catch(() => undefined);
      } catch (err) {
        if (!(err instanceof MutationRejected)) throw err;
      }
      return;
    case 'advance':
      return s.advance(a.ms);
    case 'partition':
      return net.setOffline(a.device, a.offline);
    case 'crash': {
      const d = devices[a.device];
      for (const tab of d.tabs.splice(0)) tab.dispose();
      return sim.openTab(d);
    }
    case 'open-tab':
      return sim.openTab(devices[a.device]);
    case 'close-tab':
      return devices[a.device].tabs.splice(a.tab, 1)[0].dispose();
    case 'grant':
      await s.flush();
      return server.grant(a.userId, a.siteId);
    case 'revoke':
      await s.flush();
      return server.revoke(a.userId, a.siteId);
    case 'gc':
      await s.flush();
      return server.gc(a.cut);
    case 'forget':
      await s.flush();
      if (devices[a.device].tabs.some((t) => t.pendingCount > 0)) return;
      return server.forgetClient?.(devices[a.device].tabs[0].clientId);
    case 'long-offline':
      net.setOffline(a.device, true);
      await s.advance(60_000);
      if (server.refresh) await server.refresh();
      await server.gc(server.lastVersion);
      net.setOffline(a.device, false);
  }
}

const PAGE_LIMIT = 3;

const flushTasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

export async function runSimulation(
  cfg: SimConfig,
  makeServer: (clock: () => number) => SimServer = (clock) => new ModelServer(clock),
  opts: SimOptions = {},
): Promise<SimReport> {
  const rng = mulberry32(cfg.seed);
  // IndexedDB requests finish on macrotasks, which a microtask-only settle would never wait for.
  const s = new Scheduler(opts.storage ? flushTasks : settle);
  const server = makeServer(() => s.now);
  const world = await seedWorld(rng, server);
  const served = new Map<string, Set<string>>();
  const port: SyncServerPort = {
    push: (user, req) => server.push(user, req),
    pull: (user, q) => {
      const sites = server.sitesOf(user);
      const record = (res: PullResponse) => {
        served.set(res.cursor, sites);
        return res;
      };
      const res = server.pull(user, q);
      return res instanceof Promise ? res.then(record) : record(res);
    },
  };
  const net = new SimNetwork(rng, s, port, cfg.faults);
  const openTab = (d: Device) => {
    const network = net.transportFor(d.index, d.user);
    const transport: Transport = {
      push: (req, signal) => network.push(req, signal),
      pull: async (q, signal) => {
        const res = await network.pull({ ...q, limit: PAGE_LIMIT }, signal);
        const sites = served.get(res.cursor);
        // Recorded, not thrown: the client would treat a throw as a network error and retry quietly.
        if (!sites) d.violation ??= `a pull answered with a cursor the server never issued: ${res.cursor}`;
        if (!sites) return res;
        if (res.mode === 'snapshot') d.snapshotSinceLastCheck = true;
        return res;
      },
    };
    const client = new SyncClient({
      transport,
      storage: d.storage(),
      tabs: d.hub.join(),
      clock: s.clock,
      random: rng,
      env: {},
    });
    client.start();
    d.tabs.push(client);
  };
  const run = ++runs;
  const devices = Array.from({ length: cfg.clients }, (_, index) => {
    const ledger: Ledger = { issued: [], rejected: new Set() };
    const idGen = () => uuidFrom(rng);
    const make = opts.storage;
    const memory = new DeviceStorage(idGen, ledger);
    const name = `sim-${cfg.seed}-${run}-${index}`;
    const d: Device = {
      index,
      user: pick(rng, world.users),
      storage: make ? () => new LedgerStorage(make(name, idGen), ledger) : () => memory,
      hub: new MemoryTabHub(),
      tabs: [],
      issued: ledger.issued,
      rejected: ledger.rejected,
      sitesOf: (cursor) => served.get(cursor),
      cursorVersions: new WeakMap(),
      snapshotSinceLastCheck: false,
    };
    openTab(d);
    return d;
  });
  const sim: Sim = { rng, s, net, server, world, devices, openTab };

  const trace: string[] = [];
  try {
    for (let step = 0; step < cfg.steps; step++) {
      const action = pickAction(sim, cfg.flags);
      trace.push(`${step} t=${s.now} ${JSON.stringify(action)}`);
      await perform(action, sim);
      await s.advance(int(rng, 200));
      if (server.refresh) await server.refresh();
      checkSafety(server, devices, { seed: cfg.seed, step, trace });
    }

    net.heal();
    await s.advance(600_000);
    if (server.refresh) await server.refresh();
    checkConvergence(server, devices, { seed: cfg.seed, step: cfg.steps, trace });
    return { applied: server.applied.length, rejected: server.rejectedCount, endTime: s.now, trace };
  } finally {
    for (const d of devices) for (const tab of d.tabs) tab.dispose();
  }
}

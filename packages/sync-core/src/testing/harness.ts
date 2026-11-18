import { SyncClient } from '../client/sync-client';
import { ALLOWED_TRANSITIONS, MutationRejected } from '../mutators';
import type { MutatorName, PullResponse, Row, TicketStatus } from '../protocol/types';
import { MemoryStorage } from '../storage/memory';
import type { StoredMutation } from '../storage/types';
import { MemoryTabHub } from '../tabs/memory';
import type { Transport } from '../transport/http';
import { checkConvergence, checkSafety } from './invariants';
import { ModelServer } from './model-server';
import { chance, int, mulberry32, pick, uuidFrom } from './prng';
import { Scheduler } from './scheduler';
import type { AuthUser, SimServer, SyncServerPort } from './server-port';
import { SimNetwork, type Faults } from './sim-network';

export interface SimConfig {
  seed: number;
  steps: number;
  clients: number;
  faults: Faults;
  flags: { crash: boolean; tabs: boolean; access: boolean; gc: boolean };
}

export interface SimReport {
  applied: number;
  rejected: number;
  endTime: number;
  /** One line per step: the step, the virtual time and the action. */
  trace: string[];
}

export interface World {
  sites: string[];
  users: AuthUser[];
}

export interface Device {
  index: number;
  user: AuthUser;
  storage: MemoryStorage;
  hub: MemoryTabHub;
  tabs: SyncClient[];
  /** `clientId/mutationId` of every mutation this device stored, under the client id in force at the time. */
  issued: string[];
  /** The user's sites as the server saw them when it computed the last pull page this device received. */
  sitesAtLastPull: Set<string>;
  /** Bookkeeping for invariant 3. */
  lastCursorVersion: number;
  snapshotSinceLastCheck: boolean;
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
  | { kind: 'long-offline'; device: number };

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

/** Reports every mutation it stores, so the harness knows exactly what was issued. */
class DeviceStorage extends MemoryStorage {
  constructor(
    idGen: () => string,
    private readonly onStored: (key: string) => void,
  ) {
    super({ idGen });
  }

  override async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const stored = await super.enqueue(m);
    this.onStored(`${this.read()?.clientId}/${stored.id}`);
    return stored;
  }
}

/** Three sites, one admin and four technicians, each with a random non-empty set of sites. */
async function seedWorld(rng: () => number, server: SimServer): Promise<World> {
  const sites = [uuidFrom(rng), uuidFrom(rng), uuidFrom(rng)];
  for (const site of sites) await server.addSite(site);
  const users: AuthUser[] = [{ id: uuidFrom(rng), role: 'admin' }];
  for (let i = 0; i < 4; i++) {
    const user: AuthUser = { id: uuidFrom(rng), role: 'technician' };
    const own = sites.filter(() => chance(rng, 0.5));
    for (const site of own.length ? own : [pick(rng, sites)]) await server.grant(user.id, site);
    users.push(user);
  }
  return { sites, users };
}

/**
 * A mutation from the mix: create 20 %, update 20 %, setStatus 20 % (30 % of them with a stale `from`), delete
 * 5 %, part.add 15 %, part.adjust 20 %. Targets come from the tab's own view, in 10 % of cases from the
 * server's full list instead. `undefined` when there is no target.
 */
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

/** An admin device moves one of the tickets it sees to another site. */
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
];

/** A weighted draw; an action whose flag is off or that has nothing to act on is drawn again. */
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
        if (!(err instanceof MutationRejected)) throw err; // refused locally: nothing was issued
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
      return server.grant(a.userId, a.siteId);
    case 'revoke':
      return server.revoke(a.userId, a.siteId);
    case 'gc':
      return server.gc(a.cut);
    case 'long-offline':
      net.setOffline(a.device, true);
      await s.advance(60_000);
      await server.gc(server.lastVersion);
      net.setOffline(a.device, false);
  }
}

/**
 * Runs `steps` random actions against a server (`ModelServer` unless `makeServer` gives another) over a faulty
 * network, checking safety after each, then heals the network, lets every client settle and checks convergence;
 * a violation throws `SimulationFailure`. Everything random comes from one generator seeded with `seed`, and
 * time is virtual, so a seed always replays the same run.
 */
export async function runSimulation(
  cfg: SimConfig,
  makeServer: (clock: () => number) => SimServer = (clock) => new ModelServer(clock),
): Promise<SimReport> {
  const rng = mulberry32(cfg.seed);
  const s = new Scheduler();
  const server = makeServer(() => s.now);
  const world = await seedWorld(rng, server);
  // Each page's cursor carries the fingerprint of the site set it was computed for, so equal cursors mean equal
  // sets: the sites recorded here by cursor are the ones "as of that pull" for invariant 1.
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
        const res = await network.pull(q, signal);
        const sites = served.get(res.cursor);
        if (!sites) throw new Error(`a pull answered with a cursor the server never issued: ${res.cursor}`);
        d.sitesAtLastPull = sites;
        if (res.mode === 'snapshot') d.snapshotSinceLastCheck = true;
        return res;
      },
    };
    const client = new SyncClient({
      transport,
      storage: d.storage,
      tabs: d.hub.join(),
      clock: s.clock,
      random: rng,
      env: {},
    });
    client.start();
    d.tabs.push(client);
  };
  const devices = Array.from({ length: cfg.clients }, (_, index) => {
    const issued: string[] = [];
    const d: Device = {
      index,
      user: pick(rng, world.users),
      storage: new DeviceStorage(
        () => uuidFrom(rng),
        (key) => issued.push(key),
      ),
      hub: new MemoryTabHub(),
      tabs: [],
      issued,
      sitesAtLastPull: new Set(),
      lastCursorVersion: 0,
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
    await s.advance(600_000); // several times the backoff cap and the poll period
    if (server.refresh) await server.refresh();
    checkConvergence(server, devices, { seed: cfg.seed, step: cfg.steps, trace });
    return { applied: server.applied.length, rejected: server.rejectedCount, endTime: s.now, trace };
  } finally {
    for (const d of devices) for (const tab of d.tabs) tab.dispose();
  }
}

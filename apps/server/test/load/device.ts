import {
  ALLOWED_TRANSITIONS,
  HttpTransport,
  MemoryStorage,
  MutationRejected,
  SyncClient,
  type MutatorName,
  type PullParams,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Row,
  type TicketStatus,
  type Transport,
} from '@fieldsync/sync-core';
import { int, pick } from '@fieldsync/sync-core/testing';
import { randomUUID } from 'crypto';

export interface Probe {
  key: string;
  siteId: string;
  author: Device;
  issuedAt: number;
  lastPushAt?: number;
  seen(base: ReadonlyMap<string, Row>): boolean;
}

export interface LoadStats {
  issued: number;
  localRefusals: Map<string, number>;
  pushResults: Map<string, number>;
  rejected: Map<string, string>;
  snapshots: Map<string, number>;
  probes: Map<string, Probe[]>;
  lagFromMutate: number[];
  lagFromPush: number[];
}

/** One device's network: while it is down every request fails, and going down cuts the requests in flight. */
class Link {
  online = true;
  private cut = new AbortController();
  private listeners = new Set<() => void>();

  readonly fetch: typeof fetch = (input, init) => {
    if (!this.online) return Promise.reject(new TypeError('network is down'));
    const signals = [this.cut.signal, ...(init?.signal ? [init.signal] : [])];
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };

  down(): void {
    this.online = false;
    this.cut.abort();
    this.cut = new AbortController();
  }

  up(): void {
    this.online = true;
    for (const fn of this.listeners) fn();
  }

  onUp(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const probeKey = (name: string, args: Record<string, unknown>): string | undefined => {
  if (name === 'ticket.create') return `ticket/${String(args.id)}`;
  if (name === 'part.add') return `part/${String(args.id)}`;
  if (name === 'ticket.update') return `title/${String((args.patch as { title?: unknown }).title)}`;
  return undefined;
};

export class Device {
  readonly link = new Link();
  readonly client: SyncClient;
  readonly pendingProbes = new Map<string, Probe>();
  offlineMs = 0;
  private offlineSince?: number;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  private edits = 0;

  constructor(
    readonly index: number,
    readonly siteId: string,
    apiUrl: string,
    token: string,
    private readonly rng: () => number,
    clientRng: () => number,
    private readonly stats: LoadStats,
  ) {
    const fetchImpl = this.link.fetch;
    this.client = new SyncClient({
      transport: this.observe(new HttpTransport(apiUrl, token, fetchImpl)),
      storage: new MemoryStorage(),
      stream: { url: `${apiUrl}/sync/stream`, token, fetchImpl },
      random: clientRng,
      env: { onOnline: (fn) => this.link.onUp(fn) },
    });
  }

  start(): void {
    this.client.start();
    this.later(1_000 + this.rng() * 4_000, () => this.act());
    this.later(this.onlineSpan(), () => this.toggle());
  }

  stopActing(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  heal(now: number): void {
    if (this.offlineSince !== undefined) this.offlineMs += now - this.offlineSince;
    this.offlineSince = undefined;
    if (!this.link.online) this.link.up();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }

  /** Exponential online spans averaging 130 s against 5–60 s offline: about 20% of the time offline. */
  private onlineSpan(): number {
    return -Math.log(1 - this.rng()) * 130_000;
  }

  private toggle(): void {
    if (this.link.online) {
      this.offlineSince = Date.now();
      this.link.down();
      this.later(5_000 + this.rng() * 55_000, () => this.toggle());
    } else {
      this.heal(Date.now());
      this.later(this.onlineSpan(), () => this.toggle());
    }
  }

  private act(): void {
    this.later(1_000 + this.rng() * 4_000, () => this.act());
    const [name, args] = this.nextMutation();
    try {
      void this.client.mutate(name, args);
    } catch (err) {
      if (!(err instanceof MutationRejected)) throw err;
      this.stats.localRefusals.set(err.code, (this.stats.localRefusals.get(err.code) ?? 0) + 1);
      return;
    }
    this.stats.issued += 1;
    const key = probeKey(name, args);
    if (!key) return;
    const [kind, value] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    const ticketId = String(args.id);
    const probe: Probe = {
      key,
      siteId: this.siteId,
      author: this,
      issuedAt: Date.now(),
      seen:
        kind === 'title'
          ? (base) => base.get(`ticket/${ticketId}`)?.title === value
          : (base) => base.has(key),
    };
    const list = this.stats.probes.get(this.siteId) ?? [];
    list.push(probe);
    this.stats.probes.set(this.siteId, list);
    this.pendingProbes.set(key, probe);
  }

  private nextMutation(): [MutatorName, Record<string, unknown>] {
    const rng = this.rng;
    const tickets = this.client.rows('ticket');
    const open = tickets.filter((t) => ALLOWED_TRANSITIONS[t.status as TicketStatus].length > 0);
    const parts = this.client.rows('part');
    const roll = rng();
    if (tickets.length < 5 || roll < 0.15) {
      return ['ticket.create', { id: randomUUID(), siteId: this.siteId, title: `Ticket ${this.index}`, description: '' }];
    }
    const ticket = pick(rng, tickets);
    if (roll < 0.45 || (roll < 0.65 && open.length === 0)) {
      this.edits += 1;
      return ['ticket.update', { id: ticket.id, patch: { title: `Edit ${this.index}.${this.edits}` } }];
    }
    if (roll < 0.65) {
      const t = pick(rng, open);
      const from = t.status as TicketStatus;
      return ['ticket.setStatus', { id: t.id, from, to: pick(rng, ALLOWED_TRANSITIONS[from]) }];
    }
    if (roll < 0.8 || (roll < 0.97 && parts.length === 0)) {
      return ['part.add', { id: randomUUID(), ticketId: ticket.id, name: 'Filter', quantity: 1 + int(rng, 5) }];
    }
    if (roll < 0.97) return ['part.adjust', { id: pick(rng, parts).id, delta: int(rng, 6) - 3 || 3 }];
    return ['ticket.delete', { id: ticket.id }];
  }

  private observe(inner: Transport): Transport {
    const stats = this.stats;
    return {
      push: async (req: PushRequest, signal?: AbortSignal): Promise<PushResponse> => {
        const at = Date.now();
        for (const m of req.mutations) {
          const key = probeKey(m.name, m.args);
          const probe = key && this.pendingProbes.get(key);
          if (probe) probe.lastPushAt = at;
        }
        const resp = await inner.push(req, signal);
        for (const r of resp.results) {
          stats.pushResults.set(r.status, (stats.pushResults.get(r.status) ?? 0) + 1);
          if (r.code) stats.rejected.set(`${req.clientId}/${r.id}`, r.code);
        }
        return resp;
      },
      pull: async (params: PullParams, signal?: AbortSignal): Promise<PullResponse> => {
        const resp = await inner.pull(params, signal);
        if (resp.mode === 'snapshot' && resp.reason) {
          stats.snapshots.set(resp.reason, (stats.snapshots.get(resp.reason) ?? 0) + 1);
        }
        return resp;
      },
    };
  }
}

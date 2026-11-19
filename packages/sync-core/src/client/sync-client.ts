import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import { MemoryStorage } from '../storage/memory';
import type { PersistedState, StoredMutation, StoredRejection, SyncStorage } from '../storage/types';
import type { TabCoordinator, TabMessage } from '../tabs/coordinator';
import { decodeCursor } from '../protocol/cursor';
import { TransportError } from '../transport/errors';
import { nextDelay } from './backoff';
import { CLIENT_INTERNALS, type ClientInternals } from './internals';
import { openPokeStream } from './sse';
import type { BlockReason, SyncFacts } from './status';
import type { Transport } from '../transport/http';
import type { Change, Cursor, EntityName, MutatorName, PullResponse, Row } from '../protocol/types';

export type Rejection = StoredRejection;

export type QueuedMutation = Omit<StoredMutation, 'id'> & { id?: number };

type UnsavedMutation = Omit<StoredMutation, 'id'>;

export interface SyncClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncEnvironment {
  onOnline?(fn: () => void): () => void;
  onVisible?(fn: () => void): () => void;
}

export interface PokeStreamConfig {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  watchdogMs?: number;
}

export interface SyncClientOptions {
  /** @deprecated Ignored: the storage owns the client id. Kept so existing callers still compile. */
  clientId?: string;
  transport: Transport;
  storage: SyncStorage;
  stream?: PokeStreamConfig;
  tabs?: TabCoordinator;
  queueLimits?: { warnAt?: number; max?: number };
  clock?: SyncClock;
  random?: () => number;
  env?: SyncEnvironment;
}

const realClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function browserEnvironment(): SyncEnvironment {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {};
  return {
    onOnline(fn) {
      window.addEventListener('online', fn);
      return () => window.removeEventListener('online', fn);
    },
    onVisible(fn) {
      const listener = () => {
        if (document.visibilityState === 'visible') fn();
      };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

const POLL_MS = 30_000;

class MapTx implements MutatorTx {
  constructor(private readonly state: Map<string, Row>) {}

  get(entity: EntityName, id: string): Row | undefined {
    return this.state.get(`${entity}/${id}`);
  }

  exists(entity: EntityName, id: string): boolean {
    return this.state.has(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.state.set(`${entity}/${id}`, row);
  }

  del(entity: EntityName, id: string): void {
    this.state.delete(`${entity}/${id}`);
  }

  scan(entity: 'part', by: { ticketId: string }): Row[] {
    const rows: Row[] = [];
    for (const [key, row] of this.state) {
      if (key.startsWith(`${entity}/`) && row.ticketId === by.ticketId) rows.push(row);
    }
    return rows;
  }
}

const NO_ROWS: readonly Row[] = [];

function applyLocally(state: Map<string, Row>, m: UnsavedMutation): void {
  try {
    getMutator(m.name)?.apply(new MapTx(state), m.args, { now: m.createdAt });
  } catch (err) {
    if (!(err instanceof MutationRejected)) throw err;
  }
}

export class SyncClient {
  readonly ready: Promise<void>;
  private readonly transport: Transport;
  private storage: SyncStorage;
  private readonly clock: SyncClock;
  private readonly random: () => number;
  private readonly env: SyncEnvironment;
  private readonly streamConfig?: PokeStreamConfig;
  private tabs?: TabCoordinator;
  private isLeader: boolean;
  private readonly abort = new AbortController();
  private streamAbort = new AbortController();
  private streamTimer?: unknown;
  private id = '';
  private base = new Map<string, Row>();
  private cursor: Cursor | null = null;
  private lastMutationId = 0;
  private queue: StoredMutation[] = [];
  private pushedUpTo = 0;
  private outOfOrderRetried = false;
  private unsaved: UnsavedMutation[] = [];
  private readonly warnAt: number;
  private readonly maxQueue: number;
  private queueWarned = false;
  private dataVersion = 0;
  private derived?: {
    version: number;
    view: ReadonlyMap<string, Row>;
    byEntity: Map<string, readonly Row[]>;
    pending: readonly QueuedMutation[];
  };
  private writeChain: Promise<unknown>;
  private listeners = new Set<() => void>();
  private currentFacts: SyncFacts = {
    connection: 'online',
    phase: 'idle',
    pendingCount: 0,
    unresolvedRejections: 0,
    blocked: null,
    storage: 'durable',
  };
  private rejected: readonly Rejection[] = [];
  private changeCount = 0;
  private running?: Promise<void>;
  private rerun = false;
  private attempt = 0;
  private retryTimer?: unknown;
  private pollTimer?: unknown;
  private unsubscribe: (() => void)[] = [];
  private started = false;
  private disposed = false;
  private selfBlocked = false;

  constructor(opts: SyncClientOptions) {
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? Math.random;
    this.env = opts.env ?? browserEnvironment();
    this.streamConfig = opts.stream;
    this.tabs = opts.tabs;
    this.isLeader = !opts.tabs;
    this.warnAt = opts.queueLimits?.warnAt ?? 1_000;
    this.maxQueue = opts.queueLimits?.max ?? 10_000;
    const offVersionChange = this.storage.onVersionChange?.(() => this.block('upgrade'));
    if (offVersionChange) this.unsubscribe.push(offVersionChange);
    this.ready = this.boot();
    this.writeChain = this.ready;
  }

  get clientId(): string {
    return this.id;
  }

  get facts(): SyncFacts {
    return this.currentFacts;
  }

  get pendingCount(): number {
    return this.queue.length + this.unsaved.length;
  }

  get pending(): readonly QueuedMutation[] {
    return this.derive().pending;
  }

  /** False until the first pull is stored: an empty view then means "not loaded yet", not "nothing there". */
  get hasSynced(): boolean {
    return this.cursor !== null;
  }

  /** Changes whenever the set of sites the server replicates to this user changes. */
  get siteFingerprint(): string | null {
    return this.cursor ? (decodeCursor(this.cursor)?.fp ?? null) : null;
  }

  get rejections(): readonly Rejection[] {
    return this.rejected;
  }

  async dismissRejection(rejectionId: number): Promise<void> {
    await this.serial(async () => {
      await this.storage.dismissRejection(rejectionId);
      this.adopt(await this.storage.load());
      this.emit();
    });
    this.tabs?.post({ t: 'state-changed' });
  }

  [CLIENT_INTERNALS](): ClientInternals {
    return { base: this.base, cursor: this.cursor };
  }

  get snapshotVersion(): number {
    return this.changeCount;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mutate(name: MutatorName, args: Record<string, unknown>): Promise<void> {
    const def = getMutator(name);
    if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(name)}`);
    if (this.pendingCount >= this.maxQueue) {
      throw new MutationRejected('QUEUE_FULL', `${this.pendingCount} changes are waiting to sync; reconnect first`);
    }
    const createdAt = new Date(this.clock.now()).toISOString();
    def.apply(new MapTx(new Map(this.view())), args, { now: createdAt });

    const entry: UnsavedMutation = { name, args, createdAt };
    this.unsaved.push(entry);
    this.dataVersion += 1;
    this.emit();
    if (this.pendingCount >= this.warnAt && !this.queueWarned) {
      this.queueWarned = true;
      console.warn(`fieldsync: ${this.pendingCount} changes are waiting to sync`);
    }
    const durable = this.serial(async () => {
      try {
        this.queue.push(await this.storage.enqueue(entry));
      } finally {
        this.unsaved = this.unsaved.filter((u) => u !== entry);
        this.dataVersion += 1;
        this.emit();
      }
    });
    durable.then(
      () => {
        if (this.isLeader) this.trigger();
        this.tabs?.post({ t: 'queue-changed' });
      },
      () => undefined,
    );
    return durable;
  }

  view(): ReadonlyMap<string, Row> {
    return this.derive().view;
  }

  rows(entity: EntityName): readonly Row[] {
    return this.derive().byEntity.get(entity) ?? NO_ROWS;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const request = () => void this.sync();
    if (this.env.onOnline) this.unsubscribe.push(this.env.onOnline(request));
    if (this.env.onVisible) this.unsubscribe.push(this.env.onVisible(request));
    if (this.tabs) {
      this.tabs.start(
        (leader) => this.onLeaderChange(leader),
        (m) => this.onTabMessage(m),
      );
    } else {
      this.lead();
    }
    request();
  }

  sync(): Promise<void> {
    if (this.disposed || this.currentFacts.blocked) return Promise.resolve();
    if (!this.isLeader) {
      this.tabs?.post({ t: 'sync-request' });
      return Promise.resolve();
    }
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.clearRetry();
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.sync();
      }
    });
    return this.running;
  }

  // A poke, a poll or a new mutation during a backoff wait would retry at once: the timer runs the next attempt.
  private trigger(): void {
    if (this.retryTimer === undefined) void this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.closeStream();
    this.clearRetry();
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    for (const off of this.unsubscribe.splice(0)) off();
    this.tabs?.close();
    this.storage.close();
    this.listeners.clear();
  }

  private async boot(): Promise<void> {
    let state: PersistedState;
    try {
      state = await this.storage.load();
    } catch (err) {
      console.error('fieldsync: durable storage unavailable, keeping changes in memory only:', err);
      this.storage = new MemoryStorage();
      state = await this.storage.load();
      this.setFacts({ storage: 'memory' });
      this.leaveTabs();
    }
    this.adopt(state);
    this.emit();
  }

  // The other tabs cannot see a queue kept in this tab's memory, so this tab syncs it itself.
  private leaveTabs(): void {
    if (!this.tabs) return;
    this.tabs.close();
    this.tabs = undefined;
    if (this.isLeader) return;
    this.isLeader = true;
    if (!this.started) return;
    this.lead();
    void this.sync();
  }

  private adopt(s: PersistedState): void {
    if (s.clientId !== this.id) {
      this.pushedUpTo = 0;
      this.outOfOrderRetried = false;
    }
    this.id = s.clientId;
    this.base = s.base;
    this.cursor = s.cursor;
    this.lastMutationId = s.lastMutationId;
    this.queue = s.pending;
    this.rejected = s.rejections;
    this.dataVersion += 1;
  }

  private derive(): NonNullable<SyncClient['derived']> {
    if (this.derived?.version === this.dataVersion) return this.derived;
    const view = new Map(this.base);
    for (const m of this.queue) applyLocally(view, m);
    for (const m of this.unsaved) applyLocally(view, m);
    const byEntity = new Map<string, Row[]>();
    for (const [key, row] of view) {
      const entity = key.slice(0, key.indexOf('/'));
      const list = byEntity.get(entity);
      if (list) list.push(row);
      else byEntity.set(entity, [row]);
    }
    this.derived = { version: this.dataVersion, view, byEntity, pending: [...this.queue, ...this.unsaved] };
    return this.derived;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(step);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async run(): Promise<void> {
    try {
      await this.ready;
      await this.writeChain;
      await this.push();
      await this.pull();
      this.attempt = 0;
      this.outOfOrderRetried = false;
      this.setFacts({ phase: 'idle' });
    } catch (err) {
      this.setFacts({ phase: 'idle' });
      try {
        await this.onSyncError(err);
      } catch (inner) {
        console.error('sync stopped:', inner);
        this.block('error');
      }
    }
  }

  private unpushed(): StoredMutation[] {
    const from = Math.max(this.lastMutationId, this.pushedUpTo);
    return this.queue.filter((m) => m.id > from);
  }

  private async push(): Promise<void> {
    for (;;) {
      const batch = this.unpushed().slice(0, 100);
      if (batch.length === 0) return;
      this.setFacts({ phase: 'pushing' });
      const from = Math.max(this.lastMutationId, this.pushedUpTo);
      const resp = await this.transport.push(
        { clientId: this.id, mutations: batch.map(({ id, name, args }) => ({ id, name, args })) },
        this.abort.signal,
      );
      this.setFacts({ connection: 'online' });
      const top = Math.max(from, ...resp.results.map((r) => r.id));
      if (top === from) throw new TransportError('http', 502, undefined, undefined, 'Push answered without results');
      this.pushedUpTo = top;
    }
  }

  private async onSyncError(err: unknown): Promise<void> {
    if (this.disposed) return;
    const e = err instanceof TransportError ? err : undefined;
    if (e?.status === 401) return this.block('auth');
    if (e?.status === 426) return this.block('upgrade');
    if (e?.code === 'CLIENT_MISMATCH') return this.resetClient();
    if (e?.code === 'OUT_OF_ORDER') {
      const expected = (e.details as { expected?: unknown } | undefined)?.expected;
      if (typeof expected === 'number') {
        if (expected === 1 && this.lastMutationId > 0) return this.resetClient();
        const highest = Math.max(this.lastMutationId, ...this.queue.map((m) => m.id));
        if (expected <= highest + 1 && !this.outOfOrderRetried) {
          this.outOfOrderRetried = true;
          this.pushedUpTo = expected - 1;
          return void this.sync();
        }
      }
    }
    // A 4xx without an error code comes from a proxy or gateway, not from the server's own validation.
    const retryable =
      !e || e.kind !== 'http' || e.status! >= 500 || e.status === 408 || e.status === 429 || e.code === undefined;
    if (!retryable) {
      console.error('sync stopped:', err);
      return this.block('error');
    }
    this.setFacts({ connection: e?.kind === 'http' ? 'unavailable' : 'offline' });
    const delay = nextDelay(this.attempt++, this.random);
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
  }

  private block(reason: BlockReason): void {
    this.selfBlocked = true;
    if (this.isLeader && this.tabs) {
      this.isLeader = false;
      this.tabs.resign();
    }
    this.closeStream();
    this.clearRetry();
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.setFacts({ blocked: reason, phase: 'idle' });
  }

  private async resetClient(): Promise<void> {
    await this.serial(async () => {
      this.adopt(await this.storage.resetClient());
      this.pushedUpTo = 0;
      this.outOfOrderRetried = false;
      this.emit();
    });
    this.tabs?.post({ t: 'state-changed' });
    void this.sync();
  }

  /** Snapshot pages are committed together, so storage never holds part of a snapshot. */
  private async pull(): Promise<void> {
    let cursor = this.cursor;
    let staged: Change[] | undefined;
    let droppedCursor = false;
    for (;;) {
      this.setFacts({ phase: staged ? 'resyncing' : 'pulling' });
      let resp: PullResponse;
      try {
        resp = await this.transport.pull(
          { cursor, clientId: this.id, ackedMutationId: this.lastMutationId, limit: 500 },
          this.abort.signal,
        );
      } catch (err) {
        // A stored cursor the server cannot read would fail every pull, across reloads: start from a snapshot.
        const unreadable = err instanceof TransportError && err.status === 400 && err.code === 'BAD_REQUEST';
        if (!unreadable || cursor === null || cursor !== this.cursor || droppedCursor) throw err;
        droppedCursor = true;
        cursor = null;
        continue;
      }
      this.setFacts({ connection: 'online' });
      let snapshot: Change[] | undefined;
      if (resp.mode === 'snapshot') {
        if (resp.reason || !staged) staged = [...resp.changes];
        else staged.push(...resp.changes);
        if (resp.hasMore) {
          cursor = resp.cursor;
          continue;
        }
        snapshot = staged;
      }
      staged = undefined;
      const committed = await this.serial(async () => {
        const ok = await this.storage.commitPull({
          expectedCursor: this.cursor,
          cursor: resp.cursor,
          ...(snapshot ? { snapshot } : { changes: resp.changes }),
          lastMutationId: resp.lastMutationId,
          rejections: resp.rejections,
        });
        // Also when the commit was refused: another client sharing the storage moved on; continue from there.
        this.adopt(await this.storage.load());
        this.emit();
        return ok;
      });
      cursor = this.cursor;
      if (committed) this.tabs?.post({ t: 'state-changed' });
      if (committed && !resp.hasMore && !snapshot) break;
    }
  }

  private setFacts(patch: Partial<Pick<SyncFacts, 'connection' | 'phase' | 'blocked' | 'storage'>>): void {
    const f = this.currentFacts;
    if (Object.entries(patch).every(([k, v]) => f[k as keyof SyncFacts] === v)) return;
    this.currentFacts = { ...f, ...patch };
    if (this.isLeader) this.tabs?.post({ t: 'status', facts: this.currentFacts });
    this.emit();
  }

  private lead(): void {
    this.closeStream();
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    this.schedulePoll();
    if (this.streamConfig) void this.keepStreamOpen(this.streamConfig);
  }

  private onLeaderChange(leader: boolean): void {
    if (this.disposed || !this.tabs || leader === this.isLeader) return;
    this.isLeader = leader;
    if (!leader) {
      this.closeStream();
      if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      return;
    }
    this.pushedUpTo = 0;
    this.outOfOrderRetried = false;
    if (this.currentFacts.blocked && !this.selfBlocked) this.setFacts({ blocked: null });
    void this.reload()
      .catch((err: unknown) => console.error('fieldsync: could not reload local state', err))
      .then(() => {
        if (this.disposed || !this.isLeader) return;
        this.lead();
        void this.sync();
      });
  }

  private onTabMessage(m: TabMessage): void {
    if (this.disposed) return;
    switch (m.t) {
      case 'queue-changed':
        void this.reload().then(
          () => {
            if (this.isLeader) this.trigger();
          },
          (err: unknown) => console.error('fieldsync: could not reload local state', err),
        );
        return;
      case 'sync-request':
        if (!this.isLeader) return;
        // A tab that opened after the last status change has not heard it yet.
        this.tabs?.post({ t: 'status', facts: this.currentFacts });
        this.trigger();
        return;
      case 'state-changed':
        void this.reload().catch((err: unknown) => console.error('fieldsync: could not reload local state', err));
        return;
      case 'status':
        if (this.isLeader || this.selfBlocked) return;
        this.setFacts({ connection: m.facts.connection, phase: m.facts.phase, blocked: m.facts.blocked });
    }
  }

  private reload(): Promise<void> {
    return this.serial(async () => {
      this.adopt(await this.storage.load());
      this.emit();
    });
  }

  private async keepStreamOpen(config: PokeStreamConfig): Promise<void> {
    let attempt = 0;
    const abort = (this.streamAbort = new AbortController());
    while (!this.disposed && !this.currentFacts.blocked && !abort.signal.aborted) {
      let receiving = false;
      try {
        await openPokeStream({
          ...config,
          signal: abort.signal,
          timers: this.clock,
          onOpen: () => this.trigger(),
          onData: () => {
            if (!receiving) attempt = 0;
            receiving = true;
          },
          onPoke: () => this.trigger(),
        });
      } catch (err) {
        if (this.disposed || this.currentFacts.blocked || abort.signal.aborted) return;
        if (err instanceof TransportError && err.status === 401) return this.block('auth');
        if (err instanceof TransportError && err.status === 426) return this.block('upgrade');
      }
      if (this.disposed || this.currentFacts.blocked || abort.signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.streamTimer = this.clock.setTimeout(resolve, nextDelay(attempt++, this.random));
      });
      this.streamTimer = undefined;
    }
  }

  private closeStream(): void {
    this.streamAbort.abort();
    if (this.streamTimer !== undefined) this.clock.clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private schedulePoll(): void {
    if (this.disposed || this.currentFacts.blocked) return;
    this.pollTimer = this.clock.setTimeout(
      () => {
        this.trigger();
        this.schedulePoll();
      },
      POLL_MS * (0.5 + this.random()),
    );
  }

  private emit(): void {
    const pendingCount = this.pendingCount;
    const unresolvedRejections = this.rejected.length;
    const f = this.currentFacts;
    if (f.pendingCount !== pendingCount || f.unresolvedRejections !== unresolvedRejections) {
      this.currentFacts = { ...f, pendingCount, unresolvedRejections };
    }
    if (pendingCount < this.warnAt) this.queueWarned = false;
    this.changeCount += 1;
    for (const listener of this.listeners) listener();
  }
}

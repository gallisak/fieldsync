import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import { MemoryStorage } from '../storage/memory';
import type { PersistedState, StoredMutation, StoredRejection, SyncStorage } from '../storage/types';
import type { TabCoordinator, TabMessage } from '../tabs/coordinator';
import { TransportError } from '../transport/errors';
import { nextDelay } from './backoff';
import { openPokeStream } from './sse';
import type { BlockReason, SyncFacts } from './status';
import type { Transport } from '../transport/http';
import type { Cursor, EntityName, MutatorName, Row } from '../protocol/types';

/** A mutation the server refused, with the full mutation so the UI can offer to fix and retry it. */
export type Rejection = StoredRejection;

/** A queued mutation as the UI lists it; `id` is missing while it is still being stored. */
export type QueuedMutation = Omit<StoredMutation, 'id'> & { id?: number };

/** Applied to the local view at once, but not yet in storage: it gets its id when it is stored. */
type UnsavedMutation = Omit<StoredMutation, 'id'>;

/** Time source of the client; injectable so tests and the simulator control it. */
export interface SyncClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Outside signals that make syncing worthwhile; each returns its unsubscribe function. */
export interface SyncEnvironment {
  onOnline?(fn: () => void): () => void;
  onVisible?(fn: () => void): () => void;
}

/** Where `start()` opens the server's poke stream. */
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
  /** Without it the client syncs on its own triggers only (mutations, `online`, visibility, poll). */
  stream?: PokeStreamConfig;
  /**
   * Tabs sharing the storage: only the elected one talks to the server, the others follow through storage.
   * Without it this client always leads.
   */
  tabs?: TabCoordinator;
  /** Defaults: warn at 1 000 queued mutations, refuse new ones (`QUEUE_FULL`) at 10 000. */
  queueLimits?: { warnAt?: number; max?: number };
  clock?: SyncClock;
  random?: () => number;
  /** Defaults to the browser's `online` and `visibilitychange` events, and to nothing elsewhere. */
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

/** Background poll period: 30 s, jittered so clients do not poll in step. */
const POLL_MS = 30_000;

class MapTx implements MutatorTx {
  constructor(private readonly state: Map<string, Row>) {}

  get(entity: EntityName, id: string): Row | undefined {
    return this.state.get(`${entity}/${id}`);
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
  /** Resolves once the persisted state is loaded. Nothing is pushed or pulled before that. */
  readonly ready: Promise<void>;
  private readonly transport: Transport;
  /** Replaced by a `MemoryStorage` when the given one cannot be opened (`facts.storage = 'memory'`). */
  private storage: SyncStorage;
  private readonly clock: SyncClock;
  private readonly random: () => number;
  private readonly env: SyncEnvironment;
  private readonly streamConfig?: PokeStreamConfig;
  private readonly tabs?: TabCoordinator;
  /** Only the leader pushes, pulls, keeps the stream and polls; a follower reloads from storage. */
  private isLeader: boolean;
  /** Aborted by `dispose()`: every request in flight is given up. */
  private readonly abort = new AbortController();
  /** Closes the poke stream only: `dispose()` and `block()`. */
  private streamAbort = new AbortController();
  private streamTimer?: unknown;
  private id = '';
  private base = new Map<string, Row>();
  private cursor: Cursor | null = null;
  private lastMutationId = 0;
  private queue: StoredMutation[] = [];
  /** Highest id this client has had answered by a push; entries stay in `pending` until a pull acknowledges them. */
  private pushedUpTo = 0;
  private outOfOrderRetried = false;
  private unsaved: UnsavedMutation[] = [];
  private readonly warnAt: number;
  private readonly maxQueue: number;
  private queueWarned = false;
  /** Bumped whenever base or queue change; `view()`, `rows()` and `pending` are recomputed only then. */
  private dataVersion = 0;
  private derived?: {
    version: number;
    view: ReadonlyMap<string, Row>;
    byEntity: Map<string, readonly Row[]>;
    pending: readonly QueuedMutation[];
  };
  /** Every step that reads or writes storage and updates memory from it runs here, one at a time. */
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
  /** Set when a sync is requested while one runs (a poke, a new mutation): it runs again afterwards (F3). */
  private rerun = false;
  /** Consecutive failed runs; drives the backoff. */
  private attempt = 0;
  private retryTimer?: unknown;
  private pollTimer?: unknown;
  private unsubscribe: (() => void)[] = [];
  private started = false;
  private disposed = false;

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

  /** Empty until `ready` has resolved. */
  get clientId(): string {
    return this.id;
  }

  /** A new object whenever a fact changes, so it can be a `useSyncExternalStore` snapshot as is. */
  get facts(): SyncFacts {
    return this.currentFacts;
  }

  get pendingCount(): number {
    return this.queue.length + this.unsaved.length;
  }

  /** Stored mutations in id order, then the ones still being stored. */
  get pending(): readonly QueuedMutation[] {
    return this.derive().pending;
  }

  get rejections(): readonly Rejection[] {
    return this.rejected;
  }

  /** The user has seen a rejection: it leaves the list (in every tab). */
  async dismissRejection(mutationId: number): Promise<void> {
    await this.serial(async () => {
      await this.storage.dismissRejection(mutationId);
      this.adopt(await this.storage.load());
      this.emit();
    });
    this.tabs?.post({ t: 'state-changed' });
  }

  /** Increases on every state change; usable as a cheap snapshot id for UI bindings. */
  get snapshotVersion(): number {
    return this.changeCount;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Shows the mutation in the local view at once and queues it. It is first run against the current view: a
   * mutation that cannot apply (invalid arguments, a stale status, a negative quantity …) throws its
   * `MutationRejected` here and nothing is queued. The returned promise resolves when the mutation is durable
   * (stored with its id); callers may ignore it.
   */
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
      const stored = await this.storage.enqueue(entry);
      this.unsaved = this.unsaved.filter((u) => u !== entry);
      this.queue.push(stored);
      this.dataVersion += 1;
      this.emit();
    });
    durable.then(
      () => {
        if (this.isLeader) void this.sync();
        this.tabs?.post({ t: 'queue-changed' });
      },
      () => undefined,
    );
    return durable;
  }

  /**
   * Server state, then the stored queue, then mutations still being stored. A queued mutation that no longer
   * applies (its row is gone, its status is stale) is skipped here but stays queued until the server decides.
   * Recomputed only when base or queue changed; treat the result as read-only.
   */
  view(): ReadonlyMap<string, Row> {
    return this.derive().view;
  }

  /** The rows of one entity in the view; the same array until the data changes. */
  rows(entity: EntityName): readonly Row[] {
    return this.derive().byEntity.get(entity) ?? NO_ROWS;
  }

  /**
   * Starts background syncing: one sync now, then on every stream poke, on `online`, on the page becoming
   * visible and on a jittered poll. Mutations request a sync whether or not the client was started. With
   * `tabs`, the stream and the poll run only while this tab leads; the others ask the leader to sync.
   */
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

  /**
   * Requests a sync. One runs at a time; a request during a run is remembered and runs right after it, so a
   * poke is never lost (F3). Resolves when the current run settles.
   */
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

  /** Stops everything: aborts the requests in flight, clears every timer and listener, closes storage (F21). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.closeStream();
    this.clearRetry();
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    for (const off of this.unsubscribe.splice(0)) off();
    this.tabs?.close(); // the next tab takes over
    this.storage.close();
    this.listeners.clear();
  }

  private async boot(): Promise<void> {
    let state: PersistedState;
    try {
      state = await this.storage.load();
    } catch (err) {
      // Private mode, a full disk, a blocked upgrade: keep working, but never pretend the data is safe.
      console.error('fieldsync: durable storage unavailable, keeping changes in memory only:', err);
      this.storage = new MemoryStorage();
      state = await this.storage.load();
      this.setFacts({ storage: 'memory' });
    }
    this.adopt(state);
    this.emit();
  }

  private adopt(s: PersistedState): void {
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
    this.writeChain = run.catch(() => undefined); // a failed step must not block the ones after it
    return run;
  }

  private async run(): Promise<void> {
    try {
      await this.ready;
      await this.writeChain; // every local mutation is stored and has its id
      await this.push();
      await this.pull();
      this.attempt = 0;
      this.outOfOrderRetried = false;
      this.setFacts({ phase: 'idle' });
    } catch (err) {
      this.setFacts({ phase: 'idle' });
      await this.onSyncError(err);
    }
  }

  private unpushed(): StoredMutation[] {
    const from = Math.max(this.lastMutationId, this.pushedUpTo);
    return this.queue.filter((m) => m.id > from);
  }

  /**
   * Sends what the server has not answered yet. Nothing leaves `pending` here: a mutation leaves the queue only
   * in the storage commit of the pull page that contains its effect (F16).
   */
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
      // A 200 that handled nothing would otherwise be resent at once, forever: treat it as a failure (F22).
      if (top === from) throw new TransportError('http', 502, undefined, undefined, 'Push answered without results');
      this.pushedUpTo = top;
    }
  }

  /** Decides from the error what happens to the queue and whether syncing goes on. */
  private async onSyncError(err: unknown): Promise<void> {
    if (this.disposed) return; // includes requests aborted by dispose()
    const e = err instanceof TransportError ? err : undefined;
    if (e?.status === 401) return this.block('auth');
    if (e?.status === 426) return this.block('upgrade');
    if (e?.code === 'CLIENT_MISMATCH') return this.resetClient();
    if (e?.code === 'OUT_OF_ORDER') {
      const expected = (e.details as { expected?: unknown } | undefined)?.expected;
      if (typeof expected === 'number') {
        // The server has no record of this client (e.g. a restored database): start over as a new client.
        if (expected === 1 && this.lastMutationId > 0) return this.resetClient();
        const highest = Math.max(this.lastMutationId, ...this.queue.map((m) => m.id));
        if (expected <= highest + 1 && !this.outOfOrderRetried) {
          this.outOfOrderRetried = true;
          this.pushedUpTo = expected - 1; // resend from what the server expects, right after this run
          return void this.sync();
        }
      }
    }
    const retryable = !e || e.kind !== 'http' || e.status! >= 500 || e.status === 408 || e.status === 429;
    if (!retryable) {
      console.error('sync stopped:', err);
      return this.block('error');
    }
    this.setFacts({ connection: 'offline' });
    const delay = nextDelay(this.attempt++, this.random);
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
  }

  /** Stops syncing for good (until a new client is made); the queue is kept. */
  private block(reason: BlockReason): void {
    this.closeStream();
    this.clearRetry();
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.setFacts({ blocked: reason, phase: 'idle' });
  }

  /** New client id, queue renumbered from 1; the next sync pushes everything again under the new id. */
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

  private async pull(): Promise<void> {
    for (;;) {
      this.setFacts({ phase: 'pulling' });
      const resp = await this.transport.pull(
        { cursor: this.cursor, clientId: this.id, ackedMutationId: this.lastMutationId, limit: 500 },
        this.abort.signal,
      );
      this.setFacts({ connection: 'online' });
      const committed = await this.serial(async () => {
        const ok = await this.storage.commitPull({
          expectedCursor: this.cursor,
          cursor: resp.cursor,
          changes: resp.changes,
          lastMutationId: resp.lastMutationId,
          rejections: resp.rejections,
        });
        // Also when the commit was refused: another client sharing the storage moved on; continue from there.
        this.adopt(await this.storage.load());
        this.emit();
        return ok;
      });
      if (committed) this.tabs?.post({ t: 'state-changed' });
      if (committed && !resp.hasMore) break;
    }
  }

  /** Changes facts; the leader shares connection, phase and blocking with the other tabs. */
  private setFacts(patch: Partial<Pick<SyncFacts, 'connection' | 'phase' | 'blocked' | 'storage'>>): void {
    const f = this.currentFacts;
    if (Object.entries(patch).every(([k, v]) => f[k as keyof SyncFacts] === v)) return;
    this.currentFacts = { ...f, ...patch };
    if (this.isLeader) this.tabs?.post({ t: 'status', facts: this.currentFacts });
    this.emit();
  }

  /** Leader duties beyond syncing on request: the poke stream and the background poll. */
  private lead(): void {
    this.schedulePoll();
    if (this.streamConfig) void this.keepStreamOpen(this.streamConfig);
  }

  private onLeaderChange(leader: boolean): void {
    if (this.disposed || leader === this.isLeader) return;
    this.isLeader = leader;
    if (!leader) {
      this.closeStream();
      if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      return;
    }
    // What the previous leader left in storage is the starting point; anything it had not pushed goes now.
    void this.reload().then(() => {
      this.lead();
      void this.sync();
    });
  }

  private onTabMessage(m: TabMessage): void {
    if (this.disposed) return;
    switch (m.t) {
      case 'queue-changed':
        void this.reload().then(() => {
          if (this.isLeader) void this.sync();
        });
        return;
      case 'sync-request':
        if (this.isLeader) void this.sync();
        return;
      case 'state-changed':
        void this.reload();
        return;
      case 'status':
        if (this.isLeader) return;
        this.setFacts({ connection: m.facts.connection, phase: m.facts.phase, blocked: m.facts.blocked });
    }
  }

  private reload(): Promise<void> {
    return this.serial(async () => {
      this.adopt(await this.storage.load());
      this.emit();
    });
  }

  /**
   * Keeps the poke stream open: reopens after an end or an error with backoff (reset by the first byte of a
   * connection). Every successful open requests a sync, since pokes may have been missed while disconnected.
   */
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
          onOpen: () => void this.sync(),
          onData: () => {
            if (!receiving) attempt = 0;
            receiving = true;
          },
          onPoke: () => void this.sync(),
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
        void this.sync();
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

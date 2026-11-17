import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import type { PersistedState, StoredMutation, SyncStorage } from '../storage/types';
import { TransportError } from '../transport/errors';
import type { Transport } from '../transport/http';
import type { Cursor, EntityName, Mutation, MutatorName, Row } from '../protocol/types';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'blocked';

/** Why syncing stopped; the queue is kept. `auth`: sign in again; `upgrade`: reload newer code. */
export type BlockReason = 'auth' | 'upgrade' | 'error';

export interface Rejection {
  mutation: Mutation;
  error: string;
}

/** Applied to the local view at once, but not yet in storage: it gets its id when it is stored. */
type UnsavedMutation = Omit<StoredMutation, 'id'>;

export interface SyncClientOptions {
  /** @deprecated Ignored: the storage owns the client id. Kept so existing callers still compile. */
  clientId?: string;
  transport: Transport;
  storage: SyncStorage;
}

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
  private readonly storage: SyncStorage;
  private id = '';
  private base = new Map<string, Row>();
  private cursor: Cursor | null = null;
  private lastMutationId = 0;
  private pending: StoredMutation[] = [];
  /** Highest id this client has had answered by a push; entries stay in `pending` until a pull acknowledges them. */
  private pushedUpTo = 0;
  private outOfOrderRetried = false;
  private blockedBy: BlockReason | null = null;
  private unsaved: UnsavedMutation[] = [];
  /** Every step that reads or writes storage and updates memory from it runs here, one at a time. */
  private writeChain: Promise<unknown>;
  private listeners = new Set<() => void>();
  private currentStatus: SyncStatus = 'idle';
  private rejected: Rejection[] = [];
  private changeCount = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private disposed = false;

  constructor(opts: SyncClientOptions) {
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.ready = this.boot();
    this.writeChain = this.ready;
  }

  /** Empty until `ready` has resolved. */
  get clientId(): string {
    return this.id;
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get blocked(): BlockReason | null {
    return this.blockedBy;
  }

  get pendingCount(): number {
    return this.pending.length + this.unsaved.length;
  }

  get rejections(): readonly Rejection[] {
    return this.rejected;
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
   * Shows the mutation in the local view at once and queues it. Invalid arguments throw here. The returned
   * promise resolves when the mutation is durable (stored with its id); callers may ignore it.
   */
  mutate(name: MutatorName, args: Record<string, unknown>): Promise<void> {
    const def = getMutator(name);
    if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(name)}`);
    def.parse(args);

    const entry: UnsavedMutation = { name, args, createdAt: new Date().toISOString() };
    this.unsaved.push(entry);
    this.emit();
    const durable = this.serial(async () => {
      const stored = await this.storage.enqueue(entry);
      this.unsaved = this.unsaved.filter((u) => u !== entry);
      this.pending.push(stored);
      this.emit();
    });
    durable.then(
      () => void this.sync(),
      () => undefined,
    );
    return durable;
  }

  /** Server state, then the stored queue, then mutations still being stored. */
  view(): Map<string, Row> {
    const state = new Map(this.base);
    for (const m of this.pending) applyLocally(state, m);
    for (const m of this.unsaved) applyLocally(state, m);
    return state;
  }

  rows(entity: EntityName): Row[] {
    const prefix = `${entity}/`;
    return [...this.view()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row);
  }

  sync(): Promise<void> {
    if (this.disposed || this.blockedBy) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = undefined;
        if (this.unpushed().length > 0 && this.currentStatus === 'idle') void this.sync();
      });
    }
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  private async boot(): Promise<void> {
    this.adopt(await this.storage.load());
    this.emit();
  }

  private adopt(s: PersistedState): void {
    this.id = s.clientId;
    this.base = s.base;
    this.cursor = s.cursor;
    this.lastMutationId = s.lastMutationId;
    this.pending = s.pending;
    this.rejected = s.rejections.map((r) => ({ mutation: r.mutation, error: r.message }));
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(step);
    this.writeChain = run.catch(() => undefined); // a failed step must not block the ones after it
    return run;
  }

  private async runSync(): Promise<void> {
    this.setStatus('syncing');
    try {
      await this.ready;
      await this.writeChain; // every local mutation is stored and has its id
      await this.push();
      await this.pull();
      this.setStatus('idle');
    } catch (err) {
      await this.onSyncError(err);
    }
  }

  private unpushed(): StoredMutation[] {
    const from = Math.max(this.lastMutationId, this.pushedUpTo);
    return this.pending.filter((m) => m.id > from);
  }

  /**
   * Sends what the server has not answered yet. Nothing leaves `pending` here: a mutation leaves the queue only
   * in the storage commit of the pull page that contains its effect (F16).
   */
  private async push(): Promise<void> {
    for (;;) {
      const batch = this.unpushed().slice(0, 100);
      if (batch.length === 0) return;
      const resp = await this.transport.push({
        clientId: this.id,
        mutations: batch.map(({ id, name, args }) => ({ id, name, args })),
      });
      this.outOfOrderRetried = false;
      const top = Math.max(0, ...resp.results.map((r) => r.id));
      if (top <= Math.max(this.lastMutationId, this.pushedUpTo)) return; // the server handled nothing new
      this.pushedUpTo = top;
    }
  }

  /** Decides from the error what happens to the queue and whether syncing goes on. */
  private async onSyncError(err: unknown): Promise<void> {
    if (this.disposed) return;
    const e = err instanceof TransportError ? err : undefined;
    if (e?.status === 401) return this.block('auth');
    if (e?.status === 426) return this.block('upgrade');
    if (e?.code === 'CLIENT_MISMATCH') return this.resetClient();
    if (e?.code === 'OUT_OF_ORDER') {
      const expected = (e.details as { expected?: unknown } | undefined)?.expected;
      if (typeof expected === 'number') {
        // The server has no record of this client (e.g. a restored database): start over as a new client.
        if (expected === 1 && this.lastMutationId > 0) return this.resetClient();
        const highest = Math.max(this.lastMutationId, ...this.pending.map((m) => m.id));
        if (expected <= highest + 1 && !this.outOfOrderRetried) {
          this.outOfOrderRetried = true;
          this.pushedUpTo = expected - 1; // resend from what the server expects; `sync()` reruns at once
          this.setStatus('idle');
          return;
        }
      }
    }
    const retryable = !e || e.kind !== 'http' || e.status! >= 500 || e.status === 408 || e.status === 429;
    if (!retryable) {
      console.error('sync stopped:', err);
      return this.block('error');
    }
    this.setStatus('offline');
    this.scheduleRetry();
  }

  private block(reason: BlockReason): void {
    this.blockedBy = reason;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setStatus('blocked');
  }

  /** New client id, queue renumbered from 1; the next sync pushes everything again under the new id. */
  private async resetClient(): Promise<void> {
    await this.serial(async () => {
      this.adopt(await this.storage.resetClient());
      this.pushedUpTo = 0;
      this.outOfOrderRetried = false;
      this.emit();
    });
    this.setStatus('idle');
  }

  private async pull(): Promise<void> {
    for (;;) {
      const resp = await this.transport.pull({
        cursor: this.cursor,
        clientId: this.id,
        ackedMutationId: this.lastMutationId,
        limit: 500,
      });
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
      if (committed && !resp.hasMore) break;
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.sync(), 5000);
  }

  private emit(): void {
    this.changeCount += 1;
    for (const listener of this.listeners) listener();
  }
}

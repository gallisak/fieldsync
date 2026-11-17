import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import type { PersistedState, StoredMutation, SyncStorage } from '../storage/types';
import type { Transport } from '../transport/http';
import type { Cursor, EntityName, Mutation, MutatorName, Row } from '../protocol/types';

export type SyncStatus = 'idle' | 'syncing' | 'offline';

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
    if (this.disposed) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = undefined;
        if (this.pending.length > 0 && this.currentStatus !== 'offline') void this.sync();
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
    for (const r of s.rejections) this.addRejection(r.mutation, r.message);
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
    } catch {
      this.setStatus('offline');
      this.scheduleRetry();
    }
  }

  private async push(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.slice(0, 100);
    const resp = await this.transport.push({
      clientId: this.id,
      mutations: batch.map(({ id, name, args }) => ({ id, name, args })),
    });
    const handled = new Set(resp.results.map((r) => r.id));
    for (const r of resp.results) {
      if (r.status === 'rejected') {
        const mutation = batch.find((m) => m.id === r.id);
        if (mutation) this.addRejection(mutation, r.message ?? r.code ?? 'rejected');
      }
    }
    // Only the in-memory copy is dropped here (F16); storage keeps it until a pull reports it applied.
    this.pending = this.pending.filter((m) => !handled.has(m.id));
    this.emit();
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

  private addRejection(mutation: Mutation, error: string): void {
    if (this.rejected.some((r) => r.mutation.id === mutation.id)) return;
    this.rejected.push({ mutation, error });
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

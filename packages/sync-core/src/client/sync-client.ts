import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import type { SyncStorage } from '../storage/memory';
import type { Transport } from '../transport/http';
import type { Cursor, EntityName, Mutation, MutatorName, Row } from '../protocol/types';

export type SyncStatus = 'idle' | 'syncing' | 'offline';

export interface Rejection {
  mutation: Mutation;
  error: string;
}

/** `createdAt` is stamped once at enqueue time and reused as `ctx.now` on every replay. */
interface PendingMutation extends Mutation {
  createdAt: string;
}

export interface SyncClientOptions {
  clientId: string;
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

function applyLocally(state: Map<string, Row>, m: PendingMutation): void {
  try {
    getMutator(m.name)?.apply(new MapTx(state), m.args, { now: m.createdAt });
  } catch (err) {
    if (!(err instanceof MutationRejected)) throw err;
  }
}

export class SyncClient {
  readonly clientId: string;
  private readonly transport: Transport;
  private readonly storage: SyncStorage;
  private base = new Map<string, Row>();
  private cursor: Cursor | null = null;
  private lastMutationId = 0;
  private pending: PendingMutation[] = [];
  private listeners = new Set<() => void>();
  private currentStatus: SyncStatus = 'idle';
  private rejected: Rejection[] = [];
  private changeCount = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private disposed = false;

  constructor(opts: SyncClientOptions) {
    this.clientId = opts.clientId;
    this.transport = opts.transport;
    this.storage = opts.storage;
    const saved = this.storage.load();
    if (saved) {
      // A v1 numeric cursor is meaningless to a v2 server: start over with a full pull.
      this.cursor = typeof saved.cursor === 'string' ? saved.cursor : null;
      this.lastMutationId = saved.lastMutationId;
      this.base = new Map(Object.entries(saved.base));
    }
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get pendingCount(): number {
    return this.pending.length;
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

  mutate(name: MutatorName, args: Record<string, unknown>): void {
    const mutation: PendingMutation = {
      id: this.lastMutationId + this.pending.length + 1,
      name,
      args,
      createdAt: new Date().toISOString(),
    };
    this.pending.push(mutation);
    this.emit();
    void this.sync();
  }

  /** Server state with all unacknowledged local mutations applied on top. */
  view(): Map<string, Row> {
    const state = new Map(this.base);
    for (const m of this.pending) applyLocally(state, m);
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

  private async runSync(): Promise<void> {
    this.setStatus('syncing');
    try {
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
      clientId: this.clientId,
      mutations: batch.map(({ id, name, args }) => ({ id, name, args })),
    });
    const handled = new Set(resp.results.map((r) => r.id));
    for (const r of resp.results) {
      if (r.status === 'rejected') {
        const mutation = batch.find((m) => m.id === r.id);
        if (mutation) this.rejected.push({ mutation, error: r.message ?? r.code ?? 'rejected' });
      }
    }
    this.pending = this.pending.filter((m) => !handled.has(m.id));
    this.lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
    this.emit();
  }

  private async pull(): Promise<void> {
    for (;;) {
      const resp = await this.transport.pull(this.cursor, this.clientId, 500);
      for (const change of resp.changes) {
        const key = `${change.entity}/${change.id}`;
        if (change.op === 'put' && change.data) this.base.set(key, change.data);
        else this.base.delete(key);
      }
      this.cursor = resp.cursor;
      if (resp.lastMutationId !== null) this.lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
      this.pending = this.pending.filter((m) => m.id > this.lastMutationId);
      this.persist();
      this.emit();
      if (!resp.hasMore) break;
    }
  }

  private persist(): void {
    this.storage.save({
      cursor: this.cursor,
      lastMutationId: this.lastMutationId,
      base: Object.fromEntries(this.base),
    });
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

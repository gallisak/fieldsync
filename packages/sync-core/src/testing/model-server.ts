import { MutationRejected, getMutator, type MutatorTx } from '../mutators';
import { decodeCursor, encodeCursor, snapshotReason, type CursorData } from '../protocol/cursor';
import type {
  Change,
  EntityName,
  Mutation,
  MutationResult,
  PulledRejection,
  PullResponse,
  PushRequest,
  PushResponse,
  Row,
  SnapshotReason,
} from '../protocol/types';
import { TransportError } from '../transport/errors';
import type { PullParams } from '../transport/http';
import type { AuthUser, SimServer } from './server-port';

export type LogEntry = Change & { txSeq: number; clientId: string; mutationId: number };

/** `row` is undefined for a tombstone. */
export interface Entity {
  row?: Row;
  siteId: string;
  version: number;
}

interface Loaded {
  row: Row | undefined;
  siteId?: string;
}

interface Write {
  op: 'put' | 'del';
  entity: EntityName;
  id: string;
  row?: Row;
  /** Site of the live row this write replaces or removes, if there was one. */
  prevSite?: string;
}

/** `settles`: the page may acknowledge mutations, as in `PullPage`. */
type Page = Pick<PullResponse, 'mode' | 'reason' | 'changes' | 'cursor' | 'hasMore'> & { settles: boolean };

class BufferedTx implements MutatorTx {
  readonly writes: Write[] = [];

  constructor(
    private readonly loaded: Map<string, Loaded>,
    private readonly scanned: Map<string, string[]>,
  ) {}

  get(entity: EntityName, id: string): Row | undefined {
    return this.loaded.get(`${entity}/${id}`)?.row;
  }

  exists(entity: EntityName, id: string): boolean {
    return this.loaded.get(`${entity}/${id}`)?.siteId !== undefined;
  }

  scan(entity: 'part', by: { ticketId: string }): Row[] {
    const ids = this.scanned.get(`${entity}/${by.ticketId}`) ?? [];
    return ids.map((id) => this.get(entity, id)).filter((row): row is Row => row !== undefined);
  }

  put(entity: EntityName, id: string, row: Row): void {
    const prev = this.loaded.get(`${entity}/${id}`);
    this.loaded.set(`${entity}/${id}`, { row, siteId: row.siteId as string });
    this.writes.push({ op: 'put', entity, id, row, prevSite: prev?.row ? prev.siteId : undefined });
  }

  del(entity: EntityName, id: string): void {
    const prev = this.loaded.get(`${entity}/${id}`);
    if (!prev?.row) return;
    this.loaded.set(`${entity}/${id}`, { row: undefined, siteId: prev.siteId });
    this.writes.push({ op: 'del', entity, id, prevSite: prev.siteId });
  }
}

const toChange = (e: LogEntry): Change => ({
  version: e.version,
  entity: e.entity,
  id: e.id,
  siteId: e.siteId,
  op: e.op,
  data: e.data,
});

const reason = (r: PulledRejection): Omit<PulledRejection, 'mutationId'> => ({
  code: r.code,
  message: r.message,
  ...(r.details === undefined ? {} : { details: r.details }),
});

/**
 * The sync protocol in memory: the real mutators, with the decisions of `PushService`, `MutationExecutor` and
 * `PullService` taken in the same order. Each request runs to completion before the next, as the server's row
 * locks serialise them; writes reach the maps only after the last check has passed.
 */
export class ModelServer implements SimServer {
  lastVersion = 0;
  minRetained = 0;
  readonly log: LogEntry[] = [];
  readonly entities = new Map<string, Entity>();
  readonly clients = new Map<string, { userId: string; last: number }>();
  /** Keyed by `clientId/mutationId`. */
  readonly rejections = new Map<string, PulledRejection>();
  /** Every site; an admin can access all of them. */
  readonly sites = new Set<string>();
  readonly userSites = new Map<string, Set<string>>();
  /** `clientId/mutationId` of every applied mutation, in order. */
  readonly applied: string[] = [];
  /** Per live part: the quantity it was added with and the delta of each applied adjustment, by mutation. */
  private readonly parts = new Map<string, { initial: number; deltas: Map<string, number> }>();

  /** `clock` (ms) is the transaction time a mutator gets as `ctx.now`. */
  constructor(private readonly clock: () => number = () => 0) {}

  push(user: AuthUser, req: PushRequest): PushResponse {
    const results = req.mutations.map((m) => this.applyOne(user, req.clientId, m));
    const c = this.clients.get(req.clientId);
    return { results, lastMutationId: c?.userId === user.id ? c.last : 0 };
  }

  pull(user: AuthUser, q: PullParams): PullResponse {
    const sites = this.sitesOf(user);
    const fp = `${user.role === 'admin' ? '*' : ''}|${[...sites].sort().join(',')}`;
    let cur: CursorData | undefined;
    if (q.cursor) {
      cur = decodeCursor(q.cursor) ?? undefined;
      if (!cur) throw new TransportError('http', 400, 'BAD_REQUEST', undefined, 'Malformed cursor');
    }
    const reason = snapshotReason(cur, fp, this);
    const page = reason
      ? this.snapshotPage(sites, fp, { reason }, q.limit)
      : cur?.k === 's'
        ? this.snapshotPage(sites, fp, cur, q.limit)
        : this.deltaPage(sites, cur?.v ?? 0, fp, q.limit);

    const { settles, ...response } = page;
    const own = q.clientId ? this.clients.get(q.clientId) : undefined;
    const mine = own !== undefined && own.userId === user.id;
    return {
      ...response,
      lastMutationId: !settles ? null : mine ? own.last : 0,
      rejections: settles && mine ? this.rejectionsAfter(q.clientId, q.ackedMutationId) : [],
    };
  }

  get rejectedCount(): number {
    return this.rejections.size;
  }

  addSite(siteId: string): void {
    this.sites.add(siteId);
  }

  grant(userId: string, siteId: string): void {
    const sites = this.userSites.get(userId) ?? new Set<string>();
    sites.add(siteId);
    this.userSites.set(userId, sites);
  }

  revoke(userId: string, siteId: string): void {
    this.userSites.get(userId)?.delete(siteId);
  }

  /** Drops the log up to `cut` and the tombstones written there. */
  gc(cut: number): void {
    if (cut <= this.minRetained) return;
    this.minRetained = cut;
    const keep = this.log.findIndex((e) => e.version > cut);
    this.log.splice(0, keep < 0 ? this.log.length : keep);
    for (const [key, e] of this.entities) if (!e.row && e.version <= cut) this.entities.delete(key);
  }

  sitesOf(user: AuthUser): Set<string> {
    return user.role === 'admin' ? new Set(this.sites) : new Set(this.userSites.get(user.id));
  }

  liveRows(entity?: EntityName): Row[] {
    const rows: Row[] = [];
    for (const [key, e] of this.entities) {
      if (e.row && (!entity || key.startsWith(`${entity}/`))) rows.push(e.row);
    }
    return rows;
  }

  /**
   * What each part's quantity must be: the quantity it was added with plus the delta of every applied
   * adjustment. A mutation counts once, however often it was executed.
   */
  expectedQuantities(): Map<string, number> {
    const expected = new Map<string, number>();
    for (const [id, p] of this.parts)
      expected.set(
        id,
        [...p.deltas.values()].reduce((q, d) => q + d, p.initial),
      );
    return expected;
  }

  quantityOf(partId: string): number | undefined {
    return this.entities.get(`part/${partId}`)?.row?.quantity as number | undefined;
  }

  private applyOne(user: AuthUser, clientId: string, m: Mutation): MutationResult {
    const c = this.clients.get(clientId) ?? { userId: user.id, last: 0 };
    if (c.userId !== user.id) {
      throw new TransportError('http', 403, 'CLIENT_MISMATCH', undefined, 'clientId belongs to another user');
    }
    const key = `${clientId}/${m.id}`;
    if (m.id <= c.last) {
      const stored = this.rejections.get(key);
      return { id: m.id, status: 'duplicate', ...(stored ? reason(stored) : {}) };
    }
    const expected = c.last + 1;
    if (m.id !== expected) {
      throw new TransportError('http', 409, 'OUT_OF_ORDER', { expected }, `Expected mutation ${expected}`);
    }
    this.clients.set(clientId, c); // a new client's row commits with its first mutation

    let result: MutationResult;
    try {
      this.execute(user, m, clientId);
      this.applied.push(key);
      result = { id: m.id, status: 'applied' };
    } catch (err) {
      if (!(err instanceof MutationRejected)) throw err;
      const rejection: PulledRejection = {
        mutationId: m.id,
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      };
      this.rejections.set(key, rejection);
      result = { id: m.id, status: 'rejected', ...reason(rejection) };
    }
    c.last = m.id; // advanced for a rejection too, so it does not block the queue
    return result;
  }

  /** The steps of `MutationExecutor.execute`: load, authorize on stored sites, apply, authorize targets, write. */
  private execute(user: AuthUser, m: Mutation, clientId: string): void {
    const def = getMutator(m.name);
    if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(m.name)}`);
    def.parse(m.args);

    const loaded = new Map<string, Loaded>();
    for (const k of def.reads(m.args)) {
      const e = this.entities.get(`${k.entity}/${k.id}`);
      loaded.set(`${k.entity}/${k.id}`, { row: e?.row, siteId: e?.siteId });
    }
    const scanned = new Map<string, string[]>();
    for (const spec of def.scans(m.args)) {
      const ids: string[] = [];
      for (const [key, e] of this.entities) {
        if (key.startsWith(`${spec.entity}/`) && e.row?.ticketId === spec.by.ticketId) {
          ids.push(key.slice(spec.entity.length + 1));
        }
      }
      ids.sort();
      scanned.set(`${spec.entity}/${spec.by.ticketId}`, ids);
      for (const id of ids) {
        const e = this.entities.get(`${spec.entity}/${id}`);
        loaded.set(`${spec.entity}/${id}`, { row: e?.row, siteId: e?.siteId });
      }
    }

    // A deleted row still belongs to its site.
    this.authorize(
      user,
      [...loaded.values()].filter((l) => l.siteId !== undefined).map((l) => l.siteId as string),
    );
    const tx = new BufferedTx(loaded, scanned);
    def.apply(tx, m.args, { now: new Date(this.clock()).toISOString() });
    this.authorize(
      user,
      tx.writes.flatMap((w) => (w.op === 'put' ? [w.row?.siteId as string] : [])),
    );
    this.write(tx.writes, clientId, m.id);
    this.trackParts(tx.writes, m, `${clientId}/${m.id}`);
  }

  private trackParts(writes: Write[], m: Mutation, key: string): void {
    for (const w of writes) {
      if (w.entity !== 'part') continue;
      if (w.op === 'del') this.parts.delete(w.id);
      else if (!w.prevSite) this.parts.set(w.id, { initial: w.row?.quantity as number, deltas: new Map() });
    }
    if (m.name === 'part.adjust') {
      const { id, delta } = m.args as { id: string; delta: number };
      this.parts.get(id)?.deltas.set(key, delta);
    }
  }

  private authorize(user: AuthUser, siteIds: string[]): void {
    const sites = this.sitesOf(user);
    if (!siteIds.every((s) => sites.has(s))) {
      throw new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');
    }
  }

  private write(writes: Write[], clientId: string, mutationId: number): void {
    const entries: Omit<LogEntry, 'version' | 'txSeq'>[] = [];
    const versionIndex: number[] = []; // per write: the entry whose version the entity takes
    for (const w of writes) {
      const base = { entity: w.entity, id: w.id, clientId, mutationId };
      if (w.op === 'del') {
        versionIndex.push(entries.length);
        entries.push({ ...base, op: 'del', siteId: w.prevSite as string, data: null });
        continue;
      }
      const siteId = w.row?.siteId as string;
      // A row that changes site disappears from the old site's stream and appears in the new one's.
      if (w.prevSite && w.prevSite !== siteId) entries.push({ ...base, op: 'del', siteId: w.prevSite, data: null });
      versionIndex.push(entries.length);
      entries.push({ ...base, op: 'put', siteId, data: w.row ?? null });
    }
    if (entries.length === 0) return;

    const first = this.lastVersion + 1;
    this.lastVersion += entries.length;
    entries.forEach((e, i) => this.log.push({ ...e, version: first + i, txSeq: first }));
    writes.forEach((w, i) => {
      const version = first + versionIndex[i];
      this.entities.set(
        `${w.entity}/${w.id}`,
        w.op === 'put'
          ? { row: w.row, siteId: w.row?.siteId as string, version }
          : { row: undefined, siteId: w.prevSite as string, version },
      );
    });
  }

  /** `SnapshotService.page`: live rows of the user's sites in (entity, id) order, pinned at one version. */
  private snapshotPage(
    sites: Set<string>,
    fp: string,
    start: { reason: SnapshotReason } | { v: number; after: [EntityName, string] },
    limit: number,
  ): Page {
    const v = 'reason' in start ? this.lastVersion : start.v;
    const after = 'reason' in start ? undefined : `${start.after[0]}/${start.after[1]}`;
    // `entity/id` keys sort as (entity, id) does: `/` sorts below every letter of an entity name.
    const rows = [...this.entities]
      .filter(([key, e]) => e.row && sites.has(e.siteId) && (after === undefined || key > after))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit + 1)
      .map(([key, e]): Change => {
        const [entity, id] = key.split('/') as [EntityName, string];
        return { version: e.version, entity, id, siteId: e.siteId, op: 'put', data: e.row ?? null };
      });
    const hasMore = rows.length > limit;
    const changes = hasMore ? rows.slice(0, limit) : rows;
    const last = changes[changes.length - 1];
    return {
      mode: 'snapshot',
      ...('reason' in start ? { reason: start.reason } : {}),
      changes,
      cursor: hasMore
        ? encodeCursor({ k: 's', v, after: [last.entity, last.id], fp })
        : encodeCursor({ k: 'd', v, fp }),
      hasMore,
      settles: !hasMore && v === this.lastVersion,
    };
  }

  /** `PullService.deltaPage`: a page never splits a transaction; the last page's cursor is `lastVersion`. */
  private deltaPage(sites: Set<string>, after: number, fp: string, limit: number): Page {
    const page = (v: number, rows: LogEntry[], hasMore: boolean): Page => ({
      mode: 'delta',
      changes: rows.map(toChange),
      cursor: encodeCursor({ k: 'd', v, fp }),
      hasMore,
      settles: !hasMore,
    });
    if (sites.size === 0) return page(this.lastVersion, [], false);

    const rows = this.log.filter((e) => e.version > after && sites.has(e.siteId));
    if (rows.length <= limit) return page(this.lastVersion, rows, false);
    const out = rows.slice(0, limit);
    const last = out[out.length - 1];
    // A transaction's entries are contiguous, so the rest of it directly follows in `rows`.
    for (const e of rows.slice(limit)) {
      if (e.txSeq !== last.txSeq) break;
      out.push(e);
    }
    return page(out[out.length - 1].version, out, true);
  }

  private rejectionsAfter(clientId: string | undefined, acked: number): PulledRejection[] {
    const prefix = `${clientId}/`;
    return [...this.rejections]
      .filter(([key, r]) => key.startsWith(prefix) && r.mutationId > acked)
      .map(([, r]) => r)
      .sort((a, b) => a.mutationId - b.mutationId);
  }
}

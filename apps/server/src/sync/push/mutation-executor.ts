import { Injectable } from '@nestjs/common';
import {
  MutationRejected,
  getMutator,
  type EntityName,
  type Mutation,
  type MutatorTx,
  type Row,
} from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { AccessService } from '../../access/access.service';
import type { AuthUser } from '../../auth';
import { ChangeLogRepository, type LogRow } from '../repositories/change-log.repository';

const LOCK_ORDER: Record<EntityName, number> = { ticket: 0, part: 1 };

/** The same answer as for a row that does not exist, so ids of other sites cannot be probed. */
const noAccess = () => new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');

/** `row` is undefined for a missing or deleted row; `siteId` is set whenever the id exists, deleted or not. */
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
    if (!prev?.row) return; // deleting a missing row changes nothing and logs nothing
    this.loaded.set(`${entity}/${id}`, { row: undefined, siteId: prev.siteId });
    this.writes.push({ op: 'del', entity, id, prevSite: prev.siteId });
  }
}

export interface ExecutorHooks {
  /** Runs inside the transaction after the change_log insert, before the entity rows are written. */
  afterLogInsert?(c: PoolClient, m: Mutation): Promise<void>;
  /** Runs inside the transaction after the mutation's writes, before commit. */
  afterWrites?(c: PoolClient, m: Mutation): Promise<void>;
}

@Injectable()
export class MutationExecutor {
  /** Test-only seam for pausing or failing a transaction at a precise point; empty in production. */
  readonly hooks: ExecutorHooks = {};

  constructor(
    private readonly access: AccessService,
    private readonly changeLog: ChangeLogRepository,
  ) {}

  /** Applies one mutation inside the caller's transaction; returns the site ids it touched. */
  async execute(c: PoolClient, user: AuthUser, m: Mutation, clientId: string): Promise<string[]> {
    const def = getMutator(m.name);
    if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(m.name)}`);
    def.parse(m.args);

    const loaded = new Map<string, Loaded>();
    // One global lock order (tickets before parts, then by id) so concurrent mutations cannot deadlock.
    const keys = [...def.reads(m.args)].sort(
      (a, b) => LOCK_ORDER[a.entity] - LOCK_ORDER[b.entity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const key of keys) {
      const { rows } = await c.query<{ data: Row | null; site_id: string; deleted: boolean }>(
        `SELECT data, site_id, deleted FROM entities WHERE entity = $1 AND id = $2 FOR UPDATE`,
        [key.entity, key.id],
      );
      const found = rows[0];
      loaded.set(`${key.entity}/${key.id}`, {
        row: found && !found.deleted ? (found.data ?? undefined) : undefined,
        siteId: found?.site_id,
      });
    }

    const scanned = new Map<string, string[]>();
    for (const spec of def.scans(m.args)) {
      const { rows } = await c.query<{ id: string; data: Row; site_id: string }>(
        `SELECT id, data, site_id FROM entities
          WHERE entity = $1 AND NOT deleted AND data->>'ticketId' = $2
          ORDER BY id FOR UPDATE`,
        [spec.entity, spec.by.ticketId],
      );
      scanned.set(
        `${spec.entity}/${spec.by.ticketId}`,
        rows.map((r) => r.id),
      );
      for (const r of rows) loaded.set(`${spec.entity}/${r.id}`, { row: r.data, siteId: r.site_id });
    }

    // Read in this transaction, after the row locks: a revocation committed before it is always seen.
    const sites = await this.access.accessibleSites(c, user);
    // Sites come from the rows as stored, never from the arguments; a deleted row still belongs to its site.
    if ([...loaded.values()].some((l) => l.siteId !== undefined && !sites.has(l.siteId))) throw noAccess();

    const { rows: clock } = await c.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
    const tx = new BufferedTx(loaded, scanned);
    def.apply(tx, m.args, { now: clock[0].now.toISOString() });
    // Covers the target site of a create or a move.
    if (tx.writes.some((w) => w.op === 'put' && !sites.has(w.row?.siteId as string))) throw noAccess();

    const touched = await this.write(c, tx.writes, clientId, m);
    await this.hooks.afterWrites?.(c, m);
    return touched;
  }

  private async write(c: PoolClient, writes: Write[], clientId: string, m: Mutation): Promise<string[]> {
    type Entry = Omit<LogRow, 'version' | 'txSeq'>;
    const entries: Entry[] = [];
    const versionIndex: number[] = []; // per write: index of the entry whose version the entity row takes
    for (const w of writes) {
      const base = { entity: w.entity, entityId: w.id, clientId, mutationId: m.id };
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
    if (entries.length === 0) return [];

    // Taken after every entity row lock above, and held to COMMIT.
    const first = await this.changeLog.allocateVersions(c, entries.length);
    const logRows: LogRow[] = entries.map((e, i) => ({ ...e, version: first + i, txSeq: first }));
    await this.changeLog.insert(c, logRows);
    await this.hooks.afterLogInsert?.(c, m);

    for (const [i, w] of writes.entries()) {
      const version = logRows[versionIndex[i]].version;
      if (w.op === 'put') {
        await c.query(
          `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ($1, $2, $3, $4, false, $5)
           ON CONFLICT (entity, id) DO UPDATE
             SET site_id = EXCLUDED.site_id, data = EXCLUDED.data, deleted = false, version = EXCLUDED.version`,
          [w.entity, w.id, w.row?.siteId, JSON.stringify(w.row), version],
        );
      } else {
        await c.query(`UPDATE entities SET deleted = true, data = NULL, version = $3 WHERE entity = $1 AND id = $2`, [
          w.entity,
          w.id,
          version,
        ]);
      }
    }
    return [...new Set(logRows.map((r) => r.siteId))];
  }
}

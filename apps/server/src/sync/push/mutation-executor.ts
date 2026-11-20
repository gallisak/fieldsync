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
import type { AuthUser } from '../../auth/auth.guard';
import { ChangeLogRepository, type LogRow } from '../repositories/change-log.repository';

const noAccess = () => new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');

interface Loaded {
  row: Row | undefined;
  siteId?: string;
}

interface LockedRow {
  entity: EntityName;
  id: string;
  data: Row | null;
  site_id: string;
  deleted: boolean;
}

interface Write {
  op: 'put' | 'del';
  entity: EntityName;
  id: string;
  row?: Row;
  prevSite?: string;
  fresh?: boolean;
}

// FOR UPDATE on a missing row locks nothing, so a concurrent insert of the same id can win; SQLSTATE 40001 makes
// Db.tx run the mutation again, and the retry finds the row and locks it.
class ConcurrentInsert extends Error {
  readonly code = '40001';
}

class BufferedTx implements MutatorTx {
  readonly writes: Write[] = [];

  constructor(
    private readonly loaded: Map<string, Loaded>,
    private readonly scanned: Map<string, string[]>,
    private readonly people: Map<string, { admin: boolean; sites: Set<string> }>,
  ) {}

  canSee(userId: string, siteId: string): boolean {
    const p = this.people.get(userId);
    return p !== undefined && (p.admin || p.sites.has(siteId));
  }

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
    this.writes.push({
      op: 'put',
      entity,
      id,
      row,
      prevSite: prev?.row ? prev.siteId : undefined,
      fresh: prev?.siteId === undefined,
    });
  }

  del(entity: EntityName, id: string): void {
    const prev = this.loaded.get(`${entity}/${id}`);
    if (!prev?.row) return;
    this.loaded.set(`${entity}/${id}`, { row: undefined, siteId: prev.siteId });
    this.writes.push({ op: 'del', entity, id, prevSite: prev.siteId });
  }
}

export interface ExecutorHooks {
  afterLogInsert?(c: PoolClient, m: Mutation): Promise<void>;
  afterWrites?(c: PoolClient, m: Mutation): Promise<void>;
}

@Injectable()
export class MutationExecutor {
  readonly hooks: ExecutorHooks = {};

  constructor(
    private readonly access: AccessService,
    private readonly changeLog: ChangeLogRepository,
  ) {}

  async execute(c: PoolClient, user: AuthUser, m: Mutation, clientId: string): Promise<string[]> {
    const def = getMutator(m.name);
    if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(m.name)}`);
    def.parse(m.args);

    const loaded = new Map<string, Loaded>();
    const keys = def.reads(m.args);
    for (const key of keys) loaded.set(`${key.entity}/${key.id}`, { row: undefined });
    if (keys.length > 0) {
      // One global lock order (tickets before parts, then by id) so concurrent mutations cannot deadlock. Rows are
      // locked as the sort returns them.
      const { rows } = await c.query<LockedRow>(
        `SELECT entity, id, data, site_id, deleted FROM entities
          WHERE (entity, id) IN (SELECT * FROM unnest($1::text[], $2::uuid[]))
          ORDER BY entity = 'part', id FOR UPDATE`,
        [keys.map((k) => k.entity), keys.map((k) => k.id)],
      );
      for (const r of rows) {
        loaded.set(`${r.entity}/${r.id}`, { row: r.deleted ? undefined : (r.data ?? undefined), siteId: r.site_id });
      }
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

    // Read in this transaction, after the row locks: a revocation committed before it is always seen. The clock too:
    // the transaction's start time can be older than the change it now builds on.
    const { sites, now } = await this.access.accessibleSitesNow(c, user);
    if ([...loaded.values()].some((l) => l.siteId !== undefined && !sites.has(l.siteId))) throw noAccess();

    const tx = new BufferedTx(loaded, scanned, await this.loadPeople(c, m, loaded));
    def.apply(tx, m.args, { now: now.toISOString() });
    if (tx.writes.some((w) => w.op === 'put' && !sites.has(w.row?.siteId as string))) throw noAccess();

    const touched = await this.write(c, tx.writes, clientId, m);
    await this.hooks.afterWrites?.(c, m);
    return touched;
  }

  // Assignees a mutation names or finds on its tickets, with what they can see: apply() runs without the database.
  private async loadPeople(
    c: PoolClient,
    m: Mutation,
    loaded: Map<string, Loaded>,
  ): Promise<Map<string, { admin: boolean; sites: Set<string> }>> {
    const patch = (m.args as { patch?: { assigneeId?: unknown } }).patch;
    const named = [patch?.assigneeId, ...[...loaded.values()].map((l) => l.row?.assigneeId)];
    const ids = [...new Set(named.filter((id): id is string => typeof id === 'string'))];
    const people = new Map<string, { admin: boolean; sites: Set<string> }>();
    if (ids.length === 0) return people;
    const { rows } = await c.query<{ id: string; role: string; sites: string[] }>(
      `SELECT u.id, u.role, ARRAY(SELECT site_id::text FROM user_sites s WHERE s.user_id = u.id) AS sites
         FROM users u WHERE u.id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of rows) people.set(r.id, { admin: r.role === 'admin', sites: new Set(r.sites) });
    return people;
  }

  private async write(c: PoolClient, writes: Write[], clientId: string, m: Mutation): Promise<string[]> {
    type Entry = Omit<LogRow, 'version' | 'txSeq'>;
    const entries: Entry[] = [];
    const versionIndex: number[] = [];
    for (const w of writes) {
      const base = { entity: w.entity, entityId: w.id, clientId, mutationId: m.id };
      if (w.op === 'del') {
        versionIndex.push(entries.length);
        entries.push({ ...base, op: 'del', siteId: w.prevSite as string, data: null });
        continue;
      }
      const siteId = w.row?.siteId as string;
      if (w.prevSite && w.prevSite !== siteId) entries.push({ ...base, op: 'del', siteId: w.prevSite, data: null });
      versionIndex.push(entries.length);
      entries.push({ ...base, op: 'put', siteId, data: w.row ?? null });
    }
    if (entries.length === 0) return [];

    const first = await this.changeLog.append(c, entries);
    const logRows: LogRow[] = entries.map((e, i) => ({ ...e, version: first + i, txSeq: first }));
    await this.hooks.afterLogInsert?.(c, m);

    let run: { w: Write; version: number }[] = [];
    const keys = new Set<string>();
    for (const [i, w] of writes.entries()) {
      // One statement cannot change a row twice: a repeated key starts the next batch.
      const key = `${w.entity}/${w.id}`;
      if (keys.has(key)) {
        await this.writeEntities(c, run);
        run = [];
        keys.clear();
      }
      keys.add(key);
      run.push({ w, version: logRows[versionIndex[i]].version });
    }
    await this.writeEntities(c, run);
    return [...new Set(logRows.map((r) => r.siteId))];
  }

  private async writeEntities(c: PoolClient, run: { w: Write; version: number }[]): Promise<void> {
    const puts = (fresh: boolean) => run.filter((r) => r.w.op === 'put' && r.w.fresh === fresh);
    const columns = (rows: typeof run) => [
      rows.map((r) => r.w.entity),
      rows.map((r) => r.w.id),
      rows.map((r) => r.w.row?.siteId),
      rows.map((r) => JSON.stringify(r.w.row)),
      rows.map((r) => r.version),
    ];
    const insert = `INSERT INTO entities (entity, id, site_id, data, deleted, version)
       SELECT entity, id, site_id, data, false, version
         FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::jsonb[], $5::bigint[])
              AS u(entity, id, site_id, data, version)`;

    const fresh = puts(true);
    if (fresh.length > 0) {
      const { rowCount } = await c.query(`${insert} ON CONFLICT (entity, id) DO NOTHING`, columns(fresh));
      if (rowCount !== fresh.length) throw new ConcurrentInsert('an entity was inserted concurrently');
    }
    const existing = puts(false);
    if (existing.length > 0) {
      await c.query(
        `${insert} ON CONFLICT (entity, id) DO UPDATE
           SET site_id = EXCLUDED.site_id, data = EXCLUDED.data, deleted = false, version = EXCLUDED.version`,
        columns(existing),
      );
    }
    const dels = run.filter((r) => r.w.op === 'del');
    if (dels.length > 0) {
      await c.query(
        `UPDATE entities e SET deleted = true, data = NULL, version = u.version
           FROM unnest($1::text[], $2::uuid[], $3::bigint[]) AS u(entity, id, version)
          WHERE e.entity = u.entity AND e.id = u.id`,
        [dels.map((r) => r.w.entity), dels.map((r) => r.w.id), dels.map((r) => r.version)],
      );
    }
  }
}

import { MutationRejected, getMutator, type EntityName, type Mutation, type MutatorTx, type Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { authorize } from './access';
import type { AuthUser } from './auth';

interface Loaded {
  row: Row | undefined;
  siteId?: string;
}

interface Write {
  op: 'put' | 'del';
  entity: EntityName;
  id: string;
  row?: Row;
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

  scan(entity: 'part', by: { ticketId: string }): Row[] {
    const ids = this.scanned.get(`${entity}/${by.ticketId}`) ?? [];
    return ids.map((id) => this.get(entity, id)).filter((row): row is Row => row !== undefined);
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.loaded.set(`${entity}/${id}`, { row, siteId: row.siteId as string });
    this.writes.push({ op: 'put', entity, id, row });
  }

  del(entity: EntityName, id: string): void {
    const existing = this.loaded.get(`${entity}/${id}`);
    this.loaded.set(`${entity}/${id}`, { row: undefined, siteId: existing?.siteId });
    this.writes.push({ op: 'del', entity, id });
  }

  siteOf(entity: EntityName, id: string): string | undefined {
    return this.loaded.get(`${entity}/${id}`)?.siteId;
  }
}

/** Applies one mutation inside the caller's transaction; returns the site ids it touched. */
export async function applyMutation(c: PoolClient, user: AuthUser, m: Mutation): Promise<string[]> {
  const def = getMutator(m.name);
  if (!def) throw new MutationRejected('BAD_ARGS', `Unknown mutator ${String(m.name)}`);
  def.parse(m.args);

  const loaded = new Map<string, Loaded>();
  for (const key of def.reads(m.args)) {
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
    scanned.set(`${spec.entity}/${spec.by.ticketId}`, rows.map((r) => r.id));
    for (const r of rows) loaded.set(`${spec.entity}/${r.id}`, { row: r.data, siteId: r.site_id });
  }

  // Sites come from the rows as stored, never from the arguments (v2 args carry no siteId to trust).
  const existingSites = [...loaded.values()].filter((l) => l.row !== undefined).map((l) => l.siteId as string);
  await authorize(c, user, existingSites);

  const { rows: clock } = await c.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
  const tx = new BufferedTx(loaded, scanned);
  def.apply(tx, m.args, { now: clock[0].now.toISOString() });
  await authorize(
    c,
    user,
    tx.writes.flatMap((w) => (w.op === 'put' ? [w.row?.siteId as string] : [])),
  );

  const touched = new Set<string>();
  for (const w of tx.writes) {
    const siteId = w.op === 'put' ? (w.row?.siteId as string) : tx.siteOf(w.entity, w.id);
    if (!siteId) continue;
    touched.add(siteId);
    const { rows } = await c.query<{ version: string }>(
      `INSERT INTO change_log (site_id, entity, entity_id, op, data) VALUES ($1, $2, $3, $4, $5) RETURNING version`,
      [siteId, w.entity, w.id, w.op, w.op === 'put' ? JSON.stringify(w.row) : null],
    );
    const version = rows[0].version;
    if (w.op === 'put') {
      await c.query(
        `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ($1, $2, $3, $4, false, $5)
         ON CONFLICT (entity, id) DO UPDATE
           SET site_id = EXCLUDED.site_id, data = EXCLUDED.data, deleted = false, version = EXCLUDED.version`,
        [w.entity, w.id, siteId, JSON.stringify(w.row), version],
      );
    } else {
      await c.query(`UPDATE entities SET deleted = true, data = NULL, version = $3 WHERE entity = $1 AND id = $2`, [
        w.entity,
        w.id,
        version,
      ]);
    }
  }
  return [...touched];
}

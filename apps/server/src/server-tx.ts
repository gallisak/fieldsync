import { MUTATORS, MutationRejected, type EntityName, type Mutation, type MutatorTx, type Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { authorize } from './access';
import type { AuthUser } from './auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  constructor(private readonly loaded: Map<string, Loaded>) {}

  get(entity: EntityName, id: string): Row | undefined {
    return this.loaded.get(`${entity}/${id}`)?.row;
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

function assertUuids(args: Record<string, unknown>): void {
  for (const field of ['id', 'ticketId', 'siteId']) {
    const value = args[field];
    if (value !== undefined && (typeof value !== 'string' || !UUID.test(value))) {
      throw new MutationRejected('BAD_ARGS', `${field} must be a UUID`);
    }
  }
}

/** Applies one mutation inside the caller's transaction; returns the site ids it touched. */
export async function applyMutation(c: PoolClient, user: AuthUser, m: Mutation): Promise<string[]> {
  const def = MUTATORS[m.name];
  if (!def) throw new MutationRejected('UNKNOWN_MUTATOR', `Unknown mutator ${String(m.name)}`);
  assertUuids(m.args);
  await authorize(c, user, m);

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

  const tx = new BufferedTx(loaded);
  def.apply(tx, m.args);

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

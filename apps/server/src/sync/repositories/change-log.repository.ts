import { Injectable } from '@nestjs/common';
import type { EntityName, Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';

export interface LogRow {
  version: number;
  txSeq: number;
  siteId: string;
  entity: EntityName;
  entityId: string;
  op: 'put' | 'del';
  data: Row | null;
  clientId: string;
  mutationId: number;
}

export interface StoredLogRow {
  version: number;
  txSeq: number;
  siteId: string;
  entity: EntityName;
  entityId: string;
  op: 'put' | 'del';
  data: Row | null;
  clientId: string | null;
  createdAt: Date;
}

export interface LogState {
  lastVersion: number;
  minRetained: number;
  epoch: string;
}

interface DbLogRow {
  version: string;
  tx_seq: string;
  site_id: string;
  entity: EntityName;
  entity_id: string;
  op: 'put' | 'del';
  data: Row | null;
  client_id: string | null;
  created_at: Date;
}

const COLUMNS = 'version, tx_seq, site_id, entity, entity_id, op, data, client_id, created_at';

const fromDb = (r: DbLogRow): StoredLogRow => ({
  version: Number(r.version),
  txSeq: Number(r.tx_seq),
  siteId: r.site_id,
  entity: r.entity,
  entityId: r.entity_id,
  op: r.op,
  data: r.data,
  clientId: r.client_id,
  createdAt: r.created_at,
});

@Injectable()
export class ChangeLogRepository {
  /** The state and the ids `list` selects, in one round trip. */
  async state(c: PoolClient, list: { text: string; values: unknown[] }): Promise<LogState & { ids: string[] }> {
    const { rows } = await c.query<{ last_version: string; min_retained_version: string; epoch: string; ids: string[] }>(
      `SELECT last_version, min_retained_version, epoch, ARRAY(${list.text}) AS ids FROM sync_state`,
      list.values,
    );
    return {
      lastVersion: Number(rows[0].last_version),
      minRetained: Number(rows[0].min_retained_version),
      epoch: rows[0].epoch,
      ids: rows[0].ids,
    };
  }

  async after(c: PoolClient, sites: string[], version: number, n: number): Promise<StoredLogRow[]> {
    const { rows } = await c.query<DbLogRow>(
      `SELECT l.* FROM unnest($2::uuid[]) AS s(site_id)
        CROSS JOIN LATERAL (
              SELECT ${COLUMNS} FROM change_log c
               WHERE c.site_id = s.site_id AND c.version > $1
               ORDER BY c.version
               LIMIT $3) l
        ORDER BY l.version
        LIMIT $3`,
      [version, sites, n],
    );
    return rows.map(fromDb);
  }

  async restOfTx(c: PoolClient, sites: string[], txSeq: number, version: number): Promise<StoredLogRow[]> {
    const { rows } = await c.query<DbLogRow>(
      `SELECT ${COLUMNS} FROM change_log
        WHERE version > $2
          AND version < COALESCE((SELECT min(version) FROM change_log WHERE version > $2 AND tx_seq <> $1),
                                 9223372036854775807)
          AND tx_seq = $1 AND site_id = ANY($3::uuid[])
        ORDER BY version`,
      [txSeq, version, sites],
    );
    return rows.map(fromDb);
  }

  /**
   * Gives the rows consecutive versions, the first also being their txSeq, and inserts them; returns the first.
   * Locks sync_state until COMMIT, so versions become visible in allocation order (F1). Must be the last lock a
   * writing transaction takes. One statement: every writer waits for that lock, so each round trip under it counts.
   */
  async append(c: PoolClient, rows: Omit<LogRow, 'version' | 'txSeq'>[]): Promise<number> {
    const { rows: out } = await c.query<{ first: string }>(
      // statement_timestamp: after the lock waits, and still one value for every row of the change.
      `WITH v AS (
         UPDATE sync_state SET last_version = last_version + cardinality($1::uuid[])
         RETURNING last_version - cardinality($1::uuid[]) + 1 AS first
       ), logged AS (
         INSERT INTO change_log (version, tx_seq, site_id, entity, entity_id, op, data, client_id, mutation_id, created_at)
         SELECT v.first + u.n - 1, v.first, u.site_id, u.entity, u.entity_id, u.op, u.data, u.client_id, u.mutation_id,
                statement_timestamp()
           FROM v, unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::jsonb[], $6::text[], $7::bigint[])
                   WITH ORDINALITY AS u(site_id, entity, entity_id, op, data, client_id, mutation_id, n)
       )
       SELECT first FROM v`,
      [
        rows.map((r) => r.siteId),
        rows.map((r) => r.entity),
        rows.map((r) => r.entityId),
        rows.map((r) => r.op),
        rows.map((r) => (r.data === null ? null : JSON.stringify(r.data))),
        rows.map((r) => r.clientId),
        rows.map((r) => r.mutationId),
      ],
    );
    return Number(out[0].first);
  }
}

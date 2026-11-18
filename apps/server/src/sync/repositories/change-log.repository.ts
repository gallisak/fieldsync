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
}

export interface LogState {
  lastVersion: number;
  minRetained: number;
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
}

const COLUMNS = 'version, tx_seq, site_id, entity, entity_id, op, data, client_id';

const fromDb = (r: DbLogRow): StoredLogRow => ({
  version: Number(r.version),
  txSeq: Number(r.tx_seq),
  siteId: r.site_id,
  entity: r.entity,
  entityId: r.entity_id,
  op: r.op,
  data: r.data,
  clientId: r.client_id,
});

@Injectable()
export class ChangeLogRepository {
  async state(c: PoolClient): Promise<LogState> {
    const { rows } = await c.query<{ last_version: string; min_retained_version: string }>(
      `SELECT last_version, min_retained_version FROM sync_state`,
    );
    return { lastVersion: Number(rows[0].last_version), minRetained: Number(rows[0].min_retained_version) };
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

  /** Bounded by the next row of another transaction, so the scan stays on the primary key (no index on tx_seq). */
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
   * Locks sync_state until COMMIT, so versions become visible in allocation order (F1). Must be the last lock a
   * writing transaction takes.
   */
  async allocateVersions(c: PoolClient, n: number): Promise<number> {
    const { rows } = await c.query<{ last_version: string }>(
      `UPDATE sync_state SET last_version = last_version + $1 RETURNING last_version`,
      [n],
    );
    return Number(rows[0].last_version) - n + 1;
  }

  async insert(c: PoolClient, rows: LogRow[]): Promise<void> {
    if (rows.length === 0) return;
    await c.query(
      `INSERT INTO change_log (version, tx_seq, site_id, entity, entity_id, op, data, client_id, mutation_id)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::uuid[], $4::text[], $5::uuid[], $6::text[],
                            $7::jsonb[], $8::text[], $9::bigint[])`,
      [
        rows.map((r) => r.version),
        rows.map((r) => r.txSeq),
        rows.map((r) => r.siteId),
        rows.map((r) => r.entity),
        rows.map((r) => r.entityId),
        rows.map((r) => r.op),
        rows.map((r) => (r.data === null ? null : JSON.stringify(r.data))),
        rows.map((r) => r.clientId),
        rows.map((r) => r.mutationId),
      ],
    );
  }
}

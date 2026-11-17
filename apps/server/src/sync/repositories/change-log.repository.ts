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

@Injectable()
export class ChangeLogRepository {
  /**
   * Reserves `n` consecutive versions and returns the first. The UPDATE locks the single sync_state row until
   * the transaction ends, so versions become visible in exactly the order they were handed out (F1). It must
   * be the last lock a writing transaction takes.
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

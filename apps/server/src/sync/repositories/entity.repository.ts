import { Injectable } from '@nestjs/common';
import type { Change, EntityName, Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';

@Injectable()
export class EntityRepository {
  /** Every live row of the given sites as `put` changes, in version order: a full replacement for a base. */
  async live(c: PoolClient, sites: string[]): Promise<Change[]> {
    if (sites.length === 0) return [];
    const { rows } = await c.query<{ entity: EntityName; id: string; site_id: string; data: Row; version: string }>(
      `SELECT entity, id, site_id, data, version FROM entities
        WHERE NOT deleted AND site_id = ANY($1::uuid[])
        ORDER BY version`,
      [sites],
    );
    return rows.map((r) => ({
      version: Number(r.version),
      entity: r.entity,
      id: r.id,
      siteId: r.site_id,
      op: 'put',
      data: r.data,
    }));
  }
}

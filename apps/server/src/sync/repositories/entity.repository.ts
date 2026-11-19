import { Injectable } from '@nestjs/common';
import type { Change, EntityName, Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';

@Injectable()
export class EntityRepository {
  async livePage(
    c: PoolClient,
    sites: string[],
    after: [EntityName, string] | undefined,
    n: number,
  ): Promise<Change[]> {
    if (sites.length === 0) return [];
    const { rows } = await c.query<{ entity: EntityName; id: string; site_id: string; data: Row; version: string }>(
      `SELECT l.* FROM unnest($1::uuid[]) AS s(site_id)
        CROSS JOIN LATERAL (
              SELECT entity, id, site_id, data, version FROM entities e
               WHERE e.site_id = s.site_id AND NOT e.deleted
                 AND ($2::text IS NULL OR (e.entity, e.id) > ($2::text, $3::uuid))
               ORDER BY e.entity, e.id
               LIMIT $4) l
        ORDER BY l.entity, l.id
        LIMIT $4`,
      [sites, after?.[0] ?? null, after?.[1] ?? null, n],
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

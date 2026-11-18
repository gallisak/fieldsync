import { Injectable } from '@nestjs/common';
import type { Change, EntityName, Row } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';

@Injectable()
export class EntityRepository {
  /**
   * Up to `n` live rows of the given sites after the key `after`, as `put` changes. In primary-key order, so a
   * page continues on the index where the previous one stopped.
   */
  async livePage(
    c: PoolClient,
    sites: string[],
    after: [EntityName, string] | undefined,
    n: number,
  ): Promise<Change[]> {
    if (sites.length === 0) return [];
    const { rows } = await c.query<{ entity: EntityName; id: string; site_id: string; data: Row; version: string }>(
      `SELECT entity, id, site_id, data, version FROM entities
        WHERE site_id = ANY($1::uuid[]) AND NOT deleted
          AND ($2::text IS NULL OR (entity, id) > ($2::text, $3::uuid))
        ORDER BY entity, id
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

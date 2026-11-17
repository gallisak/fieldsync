import { Injectable } from '@nestjs/common';
import type { Change, PullQuery, PullResponse } from '@fieldsync/sync-core';
import { accessibleSites } from './access';
import type { AuthUser } from './auth';
import { Db } from './database/db.service';
import { decodeCursor, encodeCursor, siteFingerprint } from './sync/pull/cursor';

interface LogRow {
  version: string;
  site_id: string;
  entity: Change['entity'];
  entity_id: string;
  op: 'put' | 'del';
  data: Change['data'];
}

@Injectable()
export class PullService {
  constructor(private readonly db: Db) {}

  async pull(user: AuthUser, query: PullQuery): Promise<PullResponse> {
    const { limit, clientId } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor).v : 0;
    const sites = await accessibleSites(this.db.pool, user);
    const siteFilter = cursor === 0 ? sites : null;
    const take = Math.min(Math.max(limit, 1), 500);

    const { rows } = await this.db.pool.query<LogRow>(
      `SELECT version, site_id, entity, entity_id, op, data
         FROM change_log
        WHERE version > $1 AND ($2::uuid[] IS NULL OR site_id = ANY($2))
        ORDER BY version
        LIMIT $3`,
      [cursor, siteFilter, take],
    );

    const changes: Change[] = rows.map((r) => ({
      version: Number(r.version),
      entity: r.entity,
      id: r.entity_id,
      siteId: r.site_id,
      op: r.op,
      data: r.data,
    }));

    let lastMutationId = 0;
    if (clientId) {
      const res = await this.db.pool.query<{ last_mutation_id: string }>(
        `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
        [clientId],
      );
      lastMutationId = res.rows.length ? Number(res.rows[0].last_mutation_id) : 0;
    }

    return {
      mode: 'delta',
      changes,
      cursor: encodeCursor({
        k: 'd',
        v: changes.length ? changes[changes.length - 1].version : cursor,
        fp: siteFingerprint(user, sites),
      }),
      hasMore: rows.length === take,
      lastMutationId,
      rejections: [],
    };
  }
}

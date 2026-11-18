import { Injectable } from '@nestjs/common';
import type { EntityName, PullResponse, SnapshotReason } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { EntityRepository } from '../repositories/entity.repository';
import { encodeCursor } from './cursor';

export type PullPage = Pick<PullResponse, 'mode' | 'reason' | 'changes' | 'cursor' | 'hasMore'> & {
  /**
   * The page may acknowledge mutations (`lastMutationId`, rejections): once it is committed, the client holds
   * every change up to the version of its cursor.
   */
  settles: boolean;
};

/** Where a snapshot page starts: a new snapshot (with its reason), or the page after `after` of the one at `v`. */
export type SnapshotStart = { reason: SnapshotReason } | { v: number; after: [EntityName, string] };

/**
 * Pages of every live row of the user's sites, pinned at one version `v`. Each page is read in its own pull,
 * so later pages may hold rows newer than `v`; the last page's cursor is a delta from `v`, which replays every
 * change made while paging. Every change is a full row, so replaying one the snapshot already has is harmless.
 */
@Injectable()
export class SnapshotService {
  constructor(private readonly entities: EntityRepository) {}

  async page(
    c: PoolClient,
    sites: string[],
    fp: string,
    start: SnapshotStart,
    lastVersion: number,
    limit: number,
  ): Promise<PullPage> {
    // A new snapshot is pinned at the version this transaction sees.
    const v = 'reason' in start ? lastVersion : start.v;
    const after = 'reason' in start ? undefined : start.after;
    const rows = await this.entities.livePage(c, sites, after, limit + 1);
    const hasMore = rows.length > limit;
    const changes = hasMore ? rows.slice(0, limit) : rows;
    const last = changes[changes.length - 1];
    return {
      mode: 'snapshot',
      // Only on the first page: the client drops rows it staged from a snapshot it did not finish.
      ...('reason' in start ? { reason: start.reason } : {}),
      changes,
      cursor: hasMore
        ? encodeCursor({ k: 's', v, after: [last.entity, last.id], fp })
        : encodeCursor({ k: 'd', v, fp }),
      hasMore,
      // Changes made since `v` reach the client only with the delta that follows; until then nothing is acked.
      settles: !hasMore && v === lastVersion,
    };
  }
}

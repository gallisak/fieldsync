import { Injectable } from '@nestjs/common';
import type { EntityName, PullResponse, SnapshotReason } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { EntityRepository } from '../repositories/entity.repository';
import { encodeCursor } from './cursor';

export type PullPage = Pick<PullResponse, 'mode' | 'reason' | 'changes' | 'cursor' | 'hasMore'> & {
  settles: boolean;
};

export type SnapshotStart = { reason: SnapshotReason } | { v: number; after: [EntityName, string] };

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
    const v = 'reason' in start ? lastVersion : start.v;
    const after = 'reason' in start ? undefined : start.after;
    const rows = await this.entities.livePage(c, sites, after, limit + 1);
    const hasMore = rows.length > limit;
    const changes = hasMore ? rows.slice(0, limit) : rows;
    const last = changes[changes.length - 1];
    return {
      mode: 'snapshot',
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

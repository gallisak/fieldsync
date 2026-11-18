import { Injectable } from '@nestjs/common';
import { snapshotReason, type Change, type PullQuery, type PullResponse } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { AccessService } from './access/access.service';
import type { AuthUser } from './auth/auth.guard';
import { Db } from './database/db.service';
import { decodeCursor, encodeCursor } from './sync/pull/cursor';
import { SnapshotService, type PullPage } from './sync/pull/snapshot.service';
import { ChangeLogRepository, type LogState, type StoredLogRow } from './sync/repositories/change-log.repository';
import { ClientRepository } from './sync/repositories/client.repository';
import { RejectionRepository } from './sync/repositories/rejection.repository';

const toChange = (r: StoredLogRow): Change => ({
  version: r.version,
  entity: r.entity,
  id: r.entityId,
  siteId: r.siteId,
  op: r.op,
  data: r.data,
});

@Injectable()
export class PullService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly log: ChangeLogRepository,
    private readonly snapshots: SnapshotService,
    private readonly clients: ClientRepository,
    private readonly rejections: RejectionRepository,
  ) {}

  /** REPEATABLE READ: the changes, the cursor and lastMutationId must describe one database state (F2). */
  async pull(user: AuthUser, q: PullQuery): Promise<PullResponse> {
    return this.db.tx(
      async (c) => {
        const sites = [...(await this.access.accessibleSites(c, user))];
        const fp = this.access.fingerprint(user, sites);
        const state = await this.log.state(c);
        const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
        const reason = snapshotReason(cur, fp, state);
        const page = reason
          ? await this.snapshots.page(c, sites, fp, { reason }, state.lastVersion, q.limit)
          : cur?.k === 's'
            ? await this.snapshots.page(c, sites, fp, cur, state.lastVersion, q.limit)
            : await this.deltaPage(c, sites, cur?.v ?? 0, state, fp, q.limit);

        const { settles, ...response } = page;
        const own = q.clientId ? await this.clients.find(c, q.clientId) : undefined;
        const mine = own !== undefined && own.userId === user.id;
        return {
          ...response,
          lastMutationId: !settles ? null : mine ? own.lastMutationId : 0,
          rejections: settles && mine ? await this.rejections.listAfter(c, q.clientId!, q.ackedMutationId) : [],
        };
      },
      { isolation: 'repeatable read', readOnly: true },
    );
  }

  private async deltaPage(
    c: PoolClient,
    sites: string[],
    after: number,
    state: LogState,
    fp: string,
    limit: number,
  ): Promise<PullPage> {
    const done = (v: number, rows: StoredLogRow[], hasMore: boolean): PullPage => ({
      mode: 'delta',
      changes: rows.map(toChange),
      cursor: encodeCursor({ k: 'd', v, fp }),
      hasMore,
      settles: !hasMore,
    });
    if (sites.length === 0) return done(state.lastVersion, [], false);

    let rows = await this.log.after(c, sites, after, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) {
      rows = rows.slice(0, limit);
      const last = rows[rows.length - 1];
      rows.push(...(await this.log.restOfTx(c, sites, last.txSeq, last.version)));
    }
    // On the last page the cursor jumps to lastVersion: this snapshot holds every change up to it.
    return done(hasMore ? rows[rows.length - 1].version : state.lastVersion, rows, hasMore);
  }
}

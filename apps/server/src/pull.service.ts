import { Injectable } from '@nestjs/common';
import type { Change, PullQuery, PullResponse } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { AccessService } from './access/access.service';
import type { AuthUser } from './auth/auth.guard';
import { Db } from './database/db.service';
import { decodeCursor, encodeCursor } from './sync/pull/cursor';
import { ChangeLogRepository, type LogState, type StoredLogRow } from './sync/repositories/change-log.repository';
import { ClientRepository } from './sync/repositories/client.repository';
import { EntityRepository } from './sync/repositories/entity.repository';
import { RejectionRepository } from './sync/repositories/rejection.repository';

type Page = Pick<PullResponse, 'mode' | 'reason' | 'changes' | 'cursor' | 'hasMore'>;

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
    private readonly entities: EntityRepository,
    private readonly clients: ClientRepository,
    private readonly rejections: RejectionRepository,
  ) {}

  /**
   * One REPEATABLE READ snapshot for everything in the response (F2): the changes, the cursor and
   * lastMutationId all describe the same database state.
   */
  async pull(user: AuthUser, q: PullQuery): Promise<PullResponse> {
    return this.db.tx(
      async (c) => {
        const sites = [...(await this.access.accessibleSites(c, user))];
        const fp = this.access.fingerprint(user, sites);
        const state = await this.log.state(c);
        // No cursor is still a delta from 0, filtered by site; P6.1 makes it a snapshot.
        const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
        // The user's sites changed since the cursor was issued: the base may hold rows that are no longer
        // visible or lack rows that now are, which no delta can say, so the client gets a snapshot (F12).
        const page =
          cur && cur.fp !== fp
            ? await this.snapshotPage(c, sites, state, fp)
            : await this.deltaPage(c, sites, cur?.v ?? 0, state, fp, q.limit);

        const own = q.clientId ? await this.clients.find(c, q.clientId) : undefined;
        const mine = own !== undefined && own.userId === user.id;
        const final = !page.hasMore;
        return {
          ...page,
          // A mutation is acknowledged only on the last page, where all of its changes have been delivered.
          lastMutationId: !final ? null : mine ? own.lastMutationId : 0,
          rejections: final && mine ? await this.rejections.listAfter(c, q.clientId!, q.ackedMutationId) : [],
        };
      },
      { isolation: 'repeatable read', readOnly: true },
    );
  }

  /** Every live row of the user's sites in one page. P6.1 replaces it with a paged snapshot. */
  private async snapshotPage(c: PoolClient, sites: string[], state: LogState, fp: string): Promise<Page> {
    return {
      mode: 'snapshot',
      reason: 'access_changed',
      changes: await this.entities.live(c, sites),
      cursor: encodeCursor({ k: 'd', v: state.lastVersion, fp }),
      hasMore: false,
    };
  }

  private async deltaPage(
    c: PoolClient,
    sites: string[],
    after: number,
    state: LogState,
    fp: string,
    limit: number,
  ): Promise<Page> {
    const done = (v: number, rows: StoredLogRow[], hasMore: boolean): Page => ({
      mode: 'delta',
      changes: rows.map(toChange),
      cursor: encodeCursor({ k: 'd', v, fp }),
      hasMore,
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

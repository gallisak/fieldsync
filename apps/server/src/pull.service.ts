import { Injectable } from '@nestjs/common';
import type { Change, PullQuery, PullResponse } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { AccessService } from './access/access.service';
import type { AuthUser } from './auth';
import { Db } from './database/db.service';
import { decodeCursor, encodeCursor, type CursorData } from './sync/pull/cursor';
import { ChangeLogRepository, type LogState, type StoredLogRow } from './sync/repositories/change-log.repository';
import { ClientRepository } from './sync/repositories/client.repository';
import { RejectionRepository } from './sync/repositories/rejection.repository';

type Page = Pick<PullResponse, 'mode' | 'changes' | 'cursor' | 'hasMore'>;

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
        // Snapshot mode (P6.1) is not there yet: no cursor means a delta from 0, still filtered by site.
        const cur = q.cursor ? decodeCursor(q.cursor) : { k: 'd' as const, v: 0, fp };
        const page = await this.deltaPage(c, sites, cur, state, fp, q.limit);

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

  private async deltaPage(
    c: PoolClient,
    sites: string[],
    cur: CursorData,
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

    let rows = await this.log.after(c, sites, cur.v, limit + 1);
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

import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { QueryResultRow } from 'pg';
import type { AuthUser } from '../auth/auth.guard';

export interface Queryable {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

@Injectable()
export class AccessService {
  async accessibleSites(q: Queryable, user: AuthUser): Promise<Set<string>> {
    if (user.role === 'admin') {
      const { rows } = await q.query<{ id: string }>(`SELECT id FROM sites`);
      return new Set(rows.map((r) => r.id));
    }
    const { rows } = await q.query<{ site_id: string }>(`SELECT site_id FROM user_sites WHERE user_id = $1`, [user.id]);
    return new Set(rows.map((r) => r.site_id));
  }

  /** The query `accessibleSites` runs, to read as `ARRAY(text)` beside other columns in one round trip. */
  sitesQuery(user: AuthUser): { text: string; values: unknown[] } {
    return user.role === 'admin'
      ? { text: `SELECT id::text FROM sites`, values: [] }
      : { text: `SELECT site_id::text FROM user_sites WHERE user_id = $1`, values: [user.id] };
  }

  // The clock is read after the row locks the caller already holds.
  async accessibleSitesNow(q: Queryable, user: AuthUser): Promise<{ sites: Set<string>; now: Date }> {
    const list = this.sitesQuery(user);
    const { rows } = await q.query<{ sites: string[]; now: Date }>(
      `SELECT ARRAY(${list.text}) AS sites, clock_timestamp() AS now`,
      list.values,
    );
    return { sites: new Set(rows[0].sites), now: rows[0].now };
  }

  /** Changes with the user's sites and with the database epoch; either way the client needs a snapshot. */
  fingerprint(user: AuthUser, sites: Iterable<string>, epoch = ''): string {
    return createHash('sha256')
      .update(`${epoch}:${user.role}:${[...sites].sort().join(',')}`)
      .digest('hex')
      .slice(0, 16);
  }
}

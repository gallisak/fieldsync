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

  fingerprint(user: AuthUser, sites: Iterable<string>): string {
    return createHash('sha256')
      .update(`${user.role}:${[...sites].sort().join(',')}`)
      .digest('hex')
      .slice(0, 16);
  }
}

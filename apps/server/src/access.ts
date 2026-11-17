import { MutationRejected } from '@fieldsync/sync-core';
import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from './auth';

type Queryable = Pool | PoolClient;

/** Site ids the user may read and write. Admins can access every site. */
export async function accessibleSites(q: Queryable, user: AuthUser): Promise<string[]> {
  if (user.role === 'admin') {
    const { rows } = await q.query<{ id: string }>(`SELECT id FROM sites`);
    return rows.map((r) => r.id);
  }
  const { rows } = await q.query<{ site_id: string }>(`SELECT site_id FROM user_sites WHERE user_id = $1`, [user.id]);
  return rows.map((r) => r.site_id);
}

/** Every site the mutation reads or writes must be accessible; otherwise NO_ACCESS (same as "not found"). */
export async function authorize(q: Queryable, user: AuthUser, siteIds: string[]): Promise<void> {
  if (siteIds.length === 0) return;
  const sites = new Set(await accessibleSites(q, user));
  if (!siteIds.every((s) => sites.has(s))) {
    throw new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');
  }
}

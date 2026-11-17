import { MutationRejected, type Mutation } from '@fieldsync/sync-core';
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

export async function authorize(q: Queryable, user: AuthUser, mutation: Mutation): Promise<void> {
  const sites = await accessibleSites(q, user);
  const siteId = mutation.args.siteId;
  if (typeof siteId !== 'string' || !sites.includes(siteId)) {
    throw new MutationRejected('FORBIDDEN', 'No access to this site');
  }
}

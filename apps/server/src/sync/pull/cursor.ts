import { createHash } from 'crypto';
import { decodeCursor as decode, type CursorData } from '@fieldsync/sync-core';
import type { AuthUser } from '../../auth';
import { ApiError } from '../../common/errors';

export { encodeCursor, type CursorData } from '@fieldsync/sync-core';

/** Anything that is not a cursor this server issued is a 400 — never "start from 0" (F23). */
export function decodeCursor(raw: string): CursorData {
  const data = decode(raw);
  if (!data) throw new ApiError('BAD_REQUEST', 400, undefined, 'Malformed cursor');
  return data;
}

/** Identifies the set of sites a cursor was issued for; a different set means the client's data is stale. */
export function siteFingerprint(user: AuthUser, sites: string[]): string {
  const key = (user.role === 'admin' ? '*' : '') + [...sites].sort().join(',');
  return createHash('sha256').update(key).digest('base64url');
}

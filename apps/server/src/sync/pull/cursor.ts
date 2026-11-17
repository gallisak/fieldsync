import { createHash } from 'crypto';
import type { Cursor } from '@fieldsync/sync-core';
import { z } from 'zod';
import type { AuthUser } from '../../auth';
import { ApiError } from '../../common/errors';

const cursorSchema = z.object({
  k: z.literal('d'),
  v: z.number().int().min(0),
  fp: z.string().min(1),
});

export type CursorPayload = z.infer<typeof cursorSchema>;

export function encodeCursor(payload: CursorPayload): Cursor {
  return Buffer.from(JSON.stringify(payload)).toString('base64url') as Cursor;
}

/** Anything that is not a cursor this server issued is a 400 — never "start from 0" (F23). */
export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new ApiError('BAD_REQUEST', 400, undefined, 'Malformed cursor');
  return result.data;
}

/** Identifies the set of sites a cursor was issued for; a different set means the client's data is stale. */
export function siteFingerprint(user: AuthUser, sites: string[]): string {
  const key = (user.role === 'admin' ? '*' : '') + [...sites].sort().join(',');
  return createHash('sha256').update(key).digest('base64url');
}

import { z } from 'zod';
import type { Cursor, SnapshotReason } from './types';

const cursorSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('d'),
    v: z.number().int().min(0),
    fp: z.string().min(1),
  }),
  // Inside a snapshot pinned at `v`: the next page starts after the row `after` = [entity, id].
  z.object({
    k: z.literal('s'),
    v: z.number().int().min(0),
    after: z.tuple([z.enum(['part', 'ticket']), z.string().uuid()]),
    fp: z.string().min(1),
  }),
]);

/** What a cursor carries; clients treat the encoded form as opaque. */
export type CursorData = z.infer<typeof cursorSchema>;

// The JSON of a cursor is ASCII (literals, numbers, a uuid, a base64url fingerprint), so btoa/atob are enough
// and the same code runs in browsers and in Node.
export function encodeCursor(data: CursorData): Cursor {
  return btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') as Cursor;
}

/** `null` for anything that is not a well-formed cursor. */
export function decodeCursor(raw: string): CursorData | null {
  try {
    const parsed: unknown = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Why a pull starts a new snapshot from its first page, or `null` when it goes on from the cursor: a delta, or
 * the next page of a snapshot. A snapshot in progress restarts for the same reasons as a delta cursor: the
 * user's sites changed, the log it would continue with was collected, or the server does not know its version.
 */
export function snapshotReason(
  cursor: CursorData | undefined,
  fp: string,
  log: { lastVersion: number; minRetained: number },
): SnapshotReason | null {
  if (!cursor) return 'initial';
  if (cursor.fp !== fp) return 'access_changed';
  if (cursor.v < log.minRetained) return 'cursor_expired';
  if (cursor.v > log.lastVersion) return 'cursor_ahead';
  return null;
}

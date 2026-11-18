import { z } from 'zod';
import type { Cursor, SnapshotReason } from './types';

const cursorSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('d'),
    v: z.number().int().min(0),
    fp: z.string().min(1),
  }),
  z.object({
    k: z.literal('s'),
    v: z.number().int().min(0),
    after: z.tuple([z.enum(['part', 'ticket']), z.string().uuid()]),
    fp: z.string().min(1),
  }),
]);

export type CursorData = z.infer<typeof cursorSchema>;

// Cursor JSON is ASCII, so btoa/atob behave the same in browsers and in Node.
export function encodeCursor(data: CursorData): Cursor {
  return btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') as Cursor;
}

export function decodeCursor(raw: string): CursorData | null {
  try {
    const parsed: unknown = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

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

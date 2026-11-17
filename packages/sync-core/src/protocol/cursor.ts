import { z } from 'zod';
import type { Cursor } from './types';

const cursorSchema = z.object({
  k: z.literal('d'),
  v: z.number().int().min(0),
  fp: z.string().min(1),
});

/** What a cursor carries; clients treat the encoded form as opaque. */
export type CursorData = z.infer<typeof cursorSchema>;

// The JSON of a cursor is ASCII (a literal, a number, a base64url fingerprint), so btoa/atob are enough and
// the same code runs in browsers and in Node.
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

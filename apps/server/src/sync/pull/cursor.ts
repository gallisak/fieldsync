import { decodeCursor as decode, type CursorData } from '@fieldsync/sync-core';
import { ApiError } from '../../common/errors';

export { encodeCursor, type CursorData } from '@fieldsync/sync-core';

/** Anything that is not a cursor this server issued is a 400 — never "start from 0" (F23). */
export function decodeCursor(raw: string): CursorData {
  const data = decode(raw);
  if (!data) throw new ApiError('BAD_REQUEST', 400, undefined, 'Malformed cursor');
  return data;
}

import { decodeCursor as decode, type CursorData } from '@fieldsync/sync-core';
import { ApiError } from '../../common/errors';

export { encodeCursor, type CursorData } from '@fieldsync/sync-core';

export function decodeCursor(raw: string): CursorData {
  const data = decode(raw);
  if (!data) throw new ApiError('BAD_REQUEST', 400, undefined, 'Malformed cursor');
  return data;
}

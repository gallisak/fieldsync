import type { Cursor, Row } from '../protocol/types';

export const CLIENT_INTERNALS = Symbol('fieldsync.client-internals');

export interface ClientInternals {
  base: ReadonlyMap<string, Row>;
  cursor: Cursor | null;
}

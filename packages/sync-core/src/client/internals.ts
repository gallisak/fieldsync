import type { Cursor, Row } from '../protocol/types';

/** Key of a client's test-only accessor. Exported through `@fieldsync/sync-core/testing` only. */
export const CLIENT_INTERNALS = Symbol('fieldsync.client-internals');

/** The client's copy of the server state, before its queue is replayed on top. */
export interface ClientInternals {
  base: ReadonlyMap<string, Row>;
  cursor: Cursor | null;
}

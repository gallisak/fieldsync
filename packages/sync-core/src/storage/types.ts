import type { RejectionCode } from '../protocol/errors';
import type { Change, Cursor, Mutation, Row } from '../protocol/types';

/** A queued local mutation. `createdAt` is stamped once at enqueue time and reused as `ctx.now` on replay. */
export interface StoredMutation extends Mutation {
  createdAt: string;
}

export interface StoredRejection {
  mutation: StoredMutation;
  code: RejectionCode;
  message: string;
  details?: unknown;
  at: string;
}

export interface PersistedState {
  clientId: string;
  cursor: Cursor | null;
  lastMutationId: number;
  base: Map<string, Row>;
  pending: StoredMutation[];
  rejections: StoredRejection[];
}

export interface PullCommit {
  /** Compare-and-swap guard: the commit applies only if the stored cursor still equals this. */
  expectedCursor: Cursor | null;
  cursor: Cursor;
  changes?: Change[];
  /** Full replacement of `base` (snapshot pulls, P6.1); every entry is a `put`. */
  snapshot?: Change[];
  /** `null` leaves the queue untouched (a page that is not the last one). */
  lastMutationId: number | null;
  rejections: { mutationId: number; code: RejectionCode; message: string; details?: unknown }[];
}

/**
 * Durable client state. Every method is one atomic step, also when several clients (tabs) share the storage.
 */
export interface SyncStorage {
  /** Creates the state, with a new client id, on first use. */
  load(): Promise<PersistedState>;
  /** Assigns the next mutation id and appends the mutation to the queue. */
  enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation>;
  /** Applies one pulled page; `false` (and no change) when the cursor moved since `expectedCursor`. */
  commitPull(c: PullCommit): Promise<boolean>;
  dismissRejection(mutationId: number): Promise<void>;
  /** New client id; the queue is renumbered from 1; cursor and data are kept. */
  resetClient(): Promise<PersistedState>;
  close(): void;
}

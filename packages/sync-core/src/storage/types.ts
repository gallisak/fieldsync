import type { RejectionCode } from '../protocol/errors';
import type { Change, Cursor, Mutation, Row } from '../protocol/types';

export interface StoredMutation extends Mutation {
  createdAt: string;
}

export interface StoredRejection {
  /** Local to this device; mutation ids restart at 1 when the client id is replaced. */
  id: number;
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
  expectedCursor: Cursor | null;
  cursor: Cursor;
  changes?: Change[];
  snapshot?: Change[];
  lastMutationId: number | null;
  rejections: { mutationId: number; code: RejectionCode; message: string; details?: unknown }[];
  /** When the pull was received, stamped on new rejections; the client passes its own clock. */
  receivedAt?: string;
}

/** Every method is atomic, also when several tabs share the storage. */
export interface SyncStorage {
  load(): Promise<PersistedState>;
  enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation>;
  commitPull(c: PullCommit): Promise<boolean>;
  dismissRejection(rejectionId: number): Promise<void>;
  resetClient(): Promise<PersistedState>;
  /** 'deleted': another tab removed the database, as signing out with "discard" does. */
  onVersionChange?(listener: (reason: 'upgrade' | 'deleted') => void): () => void;
  close(): void;
}

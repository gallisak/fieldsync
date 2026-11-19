import type { RejectionCode } from '../protocol/errors';
import type { Change, Cursor, Mutation, Row } from '../protocol/types';

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
  expectedCursor: Cursor | null;
  cursor: Cursor;
  changes?: Change[];
  snapshot?: Change[];
  lastMutationId: number | null;
  rejections: { mutationId: number; code: RejectionCode; message: string; details?: unknown }[];
}

/** Every method is atomic, also when several tabs share the storage. */
export interface SyncStorage {
  load(): Promise<PersistedState>;
  enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation>;
  commitPull(c: PullCommit): Promise<boolean>;
  dismissRejection(mutationId: number): Promise<void>;
  resetClient(): Promise<PersistedState>;
  onVersionChange?(listener: () => void): () => void;
  close(): void;
}

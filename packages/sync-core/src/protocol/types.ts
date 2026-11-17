import type { RejectionCode } from './errors';

export type EntityName = 'ticket' | 'part';

export type Row = Record<string, unknown>;

export const MUTATOR_NAMES = [
  'ticket.create',
  'ticket.update',
  'ticket.setStatus',
  'ticket.delete',
  'ticket.move',
  'part.add',
  'part.adjust',
] as const;

export type MutatorName = (typeof MUTATOR_NAMES)[number];

export interface Mutation {
  /** Strictly increasing per client, starting at 1. */
  id: number;
  name: MutatorName;
  args: Record<string, unknown>;
}

export type MutationStatus = 'applied' | 'duplicate' | 'rejected';

export interface MutationResult {
  id: number;
  status: MutationStatus;
  code?: RejectionCode;
  message?: string;
  details?: unknown;
}

export interface PushRequest {
  clientId: string;
  mutations: Mutation[];
}

export interface PushResponse {
  results: MutationResult[];
  lastMutationId: number;
}

export interface Change {
  version: number;
  entity: EntityName;
  id: string;
  siteId: string;
  op: 'put' | 'del';
  data: Row | null;
}

/** Opaque position in the server's change stream: stored and echoed by the client, never parsed. */
export type Cursor = string & { readonly __brand: 'Cursor' };

export type SnapshotReason = 'initial' | 'cursor_expired' | 'access_changed' | 'cursor_ahead';

export interface PulledRejection {
  mutationId: number;
  code: RejectionCode;
  message: string;
  details?: unknown;
}

export interface PullResponse {
  mode: 'delta' | 'snapshot';
  /** Present on the first page of a snapshot. */
  reason?: SnapshotReason;
  changes: Change[];
  cursor: Cursor;
  hasMore: boolean;
  /** Only on the final page; `null` means "do not acknowledge anything from this page". */
  lastMutationId: number | null;
  rejections: PulledRejection[];
}

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

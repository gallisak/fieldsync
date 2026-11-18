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
  reason?: SnapshotReason;
  changes: Change[];
  cursor: Cursor;
  hasMore: boolean;
  lastMutationId: number | null;
  rejections: PulledRejection[];
}

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

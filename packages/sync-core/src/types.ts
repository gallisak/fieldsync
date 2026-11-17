export type EntityName = 'ticket' | 'part';

export type Row = Record<string, unknown>;

export type MutatorName =
  | 'ticket.create'
  | 'ticket.update'
  | 'ticket.setStatus'
  | 'ticket.delete'
  | 'part.add'
  | 'part.adjust';

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
  error?: string;
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

export interface PullResponse {
  changes: Change[];
  nextCursor: number;
  hasMore: boolean;
  lastMutationId: number;
}

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

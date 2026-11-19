import {
  ALLOWED_TRANSITIONS,
  type MutatorName,
  type Row,
  type StoredRejection,
  type TicketStatus,
} from '@fieldsync/sync-core';

export interface Retry {
  name: MutatorName;
  args: Record<string, unknown>;
}

export function buildRetry(r: StoredRejection, view: ReadonlyMap<string, Row>): Retry | null {
  const { name, args } = r.mutation;
  switch (r.code) {
    case 'INTERNAL':
      return { name, args };
    case 'STATUS_CONFLICT': {
      const current = view.get(`ticket/${String(args.id)}`)?.status as TicketStatus | undefined;
      const to = args.to as TicketStatus;
      if (!current || current === to || !ALLOWED_TRANSITIONS[current]?.includes(to)) return null;
      return { name, args: { id: args.id, from: current, to } };
    }
    default:
      return null;
  }
}

import type { TicketStatus } from '../protocol/types';

export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['open'],
  cancelled: [],
};

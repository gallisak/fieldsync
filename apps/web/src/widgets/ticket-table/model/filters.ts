import type { TicketStatus } from '@fieldsync/sync-core';
import type { Ticket } from '@/entities/ticket';

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export interface TicketFilters {
  site: string | null;
  status: TicketStatus | null;
}

const isStatus = (s: string | null): s is TicketStatus => s !== null && s in STATUS_LABEL;

export function readFilters(params: Pick<URLSearchParams, 'get'> | null): TicketFilters {
  const status = params?.get('status') ?? null;
  return { site: params?.get('site') || null, status: isStatus(status) ? status : null };
}

export function filterTickets(tickets: readonly Ticket[], { site, status }: TicketFilters): readonly Ticket[] {
  if (!site && !status) return tickets;
  return tickets.filter((t) => (!site || t.siteId === site) && (!status || t.status === status));
}

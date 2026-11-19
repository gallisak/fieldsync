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

const isStatus = (s: string | null): s is TicketStatus => s !== null && Object.hasOwn(STATUS_LABEL, s);

/** A site the viewer cannot see is ignored like a missing one. */
export function readFilters(params: Pick<URLSearchParams, 'get'> | null, siteIds: readonly string[]): TicketFilters {
  const status = params?.get('status') ?? null;
  const site = params?.get('site') ?? null;
  return { site: site && siteIds.includes(site) ? site : null, status: isStatus(status) ? status : null };
}

export function filterTickets(tickets: readonly Ticket[], { site, status }: TicketFilters): readonly Ticket[] {
  if (!site && !status) return tickets;
  return tickets.filter((t) => (!site || t.siteId === site) && (!status || t.status === status));
}

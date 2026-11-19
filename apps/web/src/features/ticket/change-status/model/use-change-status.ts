'use client';

import type { TicketStatus } from '@fieldsync/sync-core';
import { useMutate } from '@/shared/api';

export function useChangeStatus(ticketId: string, current: TicketStatus) {
  const mutate = useMutate();
  return (to: TicketStatus) => mutate('ticket.setStatus', { id: ticketId, from: current, to });
}

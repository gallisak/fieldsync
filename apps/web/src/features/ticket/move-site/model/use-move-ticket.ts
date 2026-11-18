'use client';

import { useMutate } from '@/shared/api';

export function useMoveTicket(ticketId: string) {
  const mutate = useMutate();
  return (toSiteId: string) => mutate('ticket.move', { id: ticketId, toSiteId });
}

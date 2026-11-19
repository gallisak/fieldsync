'use client';

import { useMutate } from '@/shared/api';

export function useDeleteTicket(ticketId: string) {
  const mutate = useMutate();
  return () => mutate('ticket.delete', { id: ticketId });
}

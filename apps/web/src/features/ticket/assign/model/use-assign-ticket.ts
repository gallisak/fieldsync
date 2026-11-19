'use client';

import { useMutate } from '@/shared/api';

export function useAssignTicket(ticketId: string) {
  const mutate = useMutate();
  return (assigneeId: string | null) => mutate('ticket.update', { id: ticketId, patch: { assigneeId } });
}

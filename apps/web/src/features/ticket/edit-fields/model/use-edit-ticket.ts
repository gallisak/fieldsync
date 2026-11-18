'use client';

import { createTicketArgs } from '@fieldsync/sync-core';
import type { z } from 'zod';
import { useMutate } from '@/shared/api';

export const ticketFields = createTicketArgs.pick({ title: true, description: true });
export type TicketFields = z.infer<typeof ticketFields>;

export function useEditTicket(ticketId: string) {
  const mutate = useMutate();
  return (patch: Partial<TicketFields>) => mutate('ticket.update', { id: ticketId, patch });
}

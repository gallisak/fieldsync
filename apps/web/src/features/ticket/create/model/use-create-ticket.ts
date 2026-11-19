'use client';

import { createTicketArgs } from '@fieldsync/sync-core';
import type { z } from 'zod';
import { useMutate } from '@/shared/api';

export const createTicketFields = createTicketArgs.omit({ id: true });
export type CreateTicketFields = z.infer<typeof createTicketFields>;

export function useCreateTicket() {
  const mutate = useMutate();
  return (fields: CreateTicketFields): string | null => {
    const id = crypto.randomUUID();
    return mutate('ticket.create', { id, ...fields }) ? id : null;
  };
}

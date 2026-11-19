'use client';

import { createTicketArgs } from '@fieldsync/sync-core';
import type { z } from 'zod';
import { useMutate } from '@/shared/api';
import { newId } from '@/shared/lib/uuid';

export const createTicketFields = createTicketArgs.omit({ id: true });
export type CreateTicketFields = z.infer<typeof createTicketFields>;

export function useCreateTicket() {
  const mutate = useMutate();
  return (fields: CreateTicketFields): { id: string; stored: Promise<boolean> } | null => {
    const id = newId();
    const stored = mutate('ticket.create', { id, ...fields });
    return stored && { id, stored };
  };
}

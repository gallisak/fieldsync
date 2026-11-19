'use client';

import { addPartArgs } from '@fieldsync/sync-core';
import type { z } from 'zod';
import { useMutate } from '@/shared/api';
import { newId } from '@/shared/lib/uuid';

export const partFields = addPartArgs.pick({ name: true, quantity: true });
export type PartFields = z.infer<typeof partFields>;

export function useAddPart(ticketId: string) {
  const mutate = useMutate();
  return (fields: PartFields) => mutate('part.add', { id: newId(), ticketId, ...fields });
}

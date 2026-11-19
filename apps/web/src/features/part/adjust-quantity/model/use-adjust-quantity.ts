'use client';

import { useMutate } from '@/shared/api';

export function useAdjustQuantity(partId: string) {
  const mutate = useMutate();
  return (delta: 1 | -1) => mutate('part.adjust', { id: partId, delta });
}

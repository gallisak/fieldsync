'use client';

import { useCallback } from 'react';
import { useSyncClient, useSyncSelector } from '@/shared/api';
import { selectPendingKeys, selectTicket, selectTickets } from './selectors';

export const useTickets = () => useSyncSelector(selectTickets);

export function useTicket(id: string) {
  return useSyncSelector(useCallback((view) => selectTicket(view, id), [id]));
}

export function usePendingKeys(): ReadonlySet<string> {
  const client = useSyncClient();
  return useSyncSelector(useCallback(() => selectPendingKeys(client.pending), [client]));
}

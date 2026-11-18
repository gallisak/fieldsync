'use client';

import { useCallback } from 'react';
import { useSyncSelector } from '@/shared/api';
import { selectPartsOfTicket } from './selectors';

export function usePartsOfTicket(ticketId: string) {
  return useSyncSelector(useCallback((view) => selectPartsOfTicket(view, ticketId), [ticketId]));
}

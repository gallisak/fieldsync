'use client';

import { deriveStatus, type SyncBadge, type SyncFacts } from '@fieldsync/sync-core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useSyncClient } from './sync-context';

export function useSyncStatus(): { badge: SyncBadge; facts: SyncFacts } {
  const client = useSyncClient();
  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  const getFacts = () => client.facts;
  const facts = useSyncExternalStore(subscribe, getFacts, getFacts);
  return useMemo(() => ({ badge: deriveStatus(facts), facts }), [facts]);
}

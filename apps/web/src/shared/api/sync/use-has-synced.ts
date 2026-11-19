'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useSyncClient } from './sync-context';

export function useHasSynced(): boolean {
  const client = useSyncClient();
  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  const get = () => client.hasSynced;
  return useSyncExternalStore(subscribe, get, get);
}

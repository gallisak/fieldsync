'use client';

import type { SyncClient } from '@fieldsync/sync-core';
import { createContext, useContext, type ReactNode } from 'react';

const SyncClientContext = createContext<SyncClient | null>(null);

export function SyncClientProvider({ client, children }: { client: SyncClient; children: ReactNode }) {
  return <SyncClientContext.Provider value={client}>{children}</SyncClientContext.Provider>;
}

export function useSyncClient(): SyncClient {
  const client = useContext(SyncClientContext);
  if (!client) throw new Error('useSyncClient() is used outside SyncClientProvider');
  return client;
}

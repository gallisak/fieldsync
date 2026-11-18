'use client';

import type { SyncClient } from '@fieldsync/sync-core';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/entities/session';
import { createSyncClient, SyncClientProvider } from '@/shared/api';
import { API_URL } from '@/shared/config';
import { FullPageSkeleton } from './full-page-skeleton';

export function SyncProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const token = session?.token;
  const userId = session?.userId;
  const [client, setClient] = useState<SyncClient | null>(null);
  const [ready, setReady] = useState<SyncClient | null>(null);

  useEffect(() => {
    if (!token || !userId) return;
    const c = createSyncClient({ apiUrl: API_URL, token, userId });
    let live = true;
    setClient(c);
    void c.ready.then(() => {
      if (live) setReady(c);
    });
    c.start();
    return () => {
      live = false;
      c.dispose();
      setClient(null);
      setReady(null);
    };
  }, [token, userId]);

  if (!session) return children;
  if (!client || ready !== client) return <FullPageSkeleton />;
  return <SyncClientProvider client={client}>{children}</SyncClientProvider>;
}

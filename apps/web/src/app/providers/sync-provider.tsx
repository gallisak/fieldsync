'use client';

import type { SyncClient } from '@fieldsync/sync-core';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/entities/session';
import { createSyncClient, SyncClientProvider } from '@/shared/api';
import { API_URL } from '@/shared/config';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { UpgradeGate } from '@/widgets/upgrade-gate';
import { FullPageSkeleton } from './full-page-skeleton';

export function SyncProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const token = session?.token;
  const userId = session?.userId;
  const [client, setClient] = useState<SyncClient | null>(null);
  const [ready, setReady] = useState<SyncClient | null>(null);
  const [failed, setFailed] = useState<SyncClient | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token || !userId) return;
    const c = createSyncClient({ apiUrl: API_URL, token, userId });
    let live = true;
    setClient(c);
    c.ready.then(
      () => {
        if (live) setReady(c);
      },
      (err: unknown) => {
        console.error('fieldsync: local storage could not be opened', err);
        if (live) setFailed(c);
      },
    );
    c.start();
    return () => {
      live = false;
      c.dispose();
      setClient(null);
      setReady(null);
      setFailed(null);
    };
  }, [token, userId, attempt]);

  if (!session) return children;
  if (client && failed === client) {
    return (
      <div className="mx-auto max-w-md p-4">
        <Alert variant="destructive">
          <AlertTitle>Storage on this device could not be opened</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Your changes stay where they are. Try again, or reload the page.</p>
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!client || ready !== client) return <FullPageSkeleton />;
  return (
    <SyncClientProvider client={client}>
      <UpgradeGate>{children}</UpgradeGate>
    </SyncClientProvider>
  );
}

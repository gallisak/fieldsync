'use client';

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  HttpTransport,
  LocalStorageSyncStorage,
  MutationRejected,
  SyncClient,
  WebLocksCoordinator,
} from '@fieldsync/sync-core';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const ClientContext = createContext<SyncClient | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem('fs_token'));
  }, []);

  useEffect(() => {
    if (!token) return;
    const c = new SyncClient({
      transport: new HttpTransport(API, token),
      storage: new LocalStorageSyncStorage('fs_state'),
      // Read over fetch so the token goes in the Authorization header, never in the URL.
      stream: { url: `${API}/sync/stream`, token },
      // Tabs share this storage: one of them talks to the server, the others follow.
      tabs: new WebLocksCoordinator('fs_state'),
    });
    setClient(c);
    c.start();
    // A new token or unmounting must not leave the old client syncing and its stream open (F21).
    return () => c.dispose();
  }, [token]);

  if (!token) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get('token');
          if (typeof value === 'string' && value) {
            localStorage.setItem('fs_token', value);
            setToken(value);
          }
        }}
      >
        <h1>FieldSync</h1>
        <p>Enter an access token (demo: admin-token, tech-a-token, tech-b-token).</p>
        <input name="token" placeholder="token" />
        <button type="submit">Sign in</button>
      </form>
    );
  }

  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useSyncClient(): SyncClient | null {
  return useContext(ClientContext);
}

/**
 * Runs an action that may call `client.mutate`; a mutation the client refuses up front (`MutationRejected`)
 * becomes a message to show instead of an error thrown out of an event handler.
 */
export function useRefusal(): [string | null, (action: () => unknown) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const act = useCallback((action: () => unknown) => {
    try {
      action();
      setMessage(null);
    } catch (err) {
      if (!(err instanceof MutationRejected)) throw err;
      setMessage(err.message);
    }
  }, []);
  return [message, act];
}

/** Re-renders whenever the client state changes. */
export function useSyncState(client: SyncClient | null): number {
  return useSyncExternalStore(
    (cb) => (client ? client.subscribe(cb) : () => undefined),
    () => (client ? client.snapshotVersion : 0),
    () => 0,
  );
}

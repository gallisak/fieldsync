'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { HttpTransport, LocalStorageSyncStorage, SyncClient } from '@fieldsync/sync-core';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const ClientContext = createContext<SyncClient | null>(null);

function getClientId(): string {
  let id = localStorage.getItem('fs_client_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('fs_client_id', id);
  }
  return id;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem('fs_token'));
  }, []);

  useEffect(() => {
    if (!token) return;
    const c = new SyncClient({
      clientId: getClientId(),
      transport: new HttpTransport(API, token),
      storage: new LocalStorageSyncStorage('fs_state'),
    });
    setClient(c);
    void c.sync();
    const es = new EventSource(`${API}/sync/stream?token=${encodeURIComponent(token)}`);
    es.addEventListener('poke', () => void c.sync());
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

/** Re-renders whenever the client state changes. */
export function useSyncState(client: SyncClient | null): number {
  return useSyncExternalStore(
    (cb) => (client ? client.subscribe(cb) : () => undefined),
    () => (client ? client.snapshotVersion : 0),
    () => 0,
  );
}

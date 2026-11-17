'use client';

import type { SyncClient } from '@fieldsync/sync-core';
import { useSyncState } from './providers';

export function StatusBar({ client }: { client: SyncClient }) {
  useSyncState(client);
  return (
    <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
      {client.status} · {client.pendingCount} pending
    </div>
  );
}

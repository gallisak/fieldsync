'use client';

import { deriveStatus, type SyncClient } from '@fieldsync/sync-core';
import { useSyncState } from './providers';

export function StatusBar({ client }: { client: SyncClient }) {
  useSyncState(client);
  return (
    <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
      {deriveStatus(client.facts)} · {client.facts.pendingCount} pending
      {client.facts.storage === 'memory' ? ' · this browser cannot store data: changes are lost on reload' : ''}
    </div>
  );
}

export interface SyncFacts {
  connection: 'online' | 'offline';
  phase: 'idle' | 'pushing' | 'pulling' | 'resyncing';
  pendingCount: number;
  unresolvedRejections: number;
  blocked: null | 'upgrade' | 'auth' | 'error';
  storage: 'durable' | 'memory';
}

export type BlockReason = NonNullable<SyncFacts['blocked']>;

export type SyncBadge = 'upgrade' | 'auth' | 'error' | 'rejected' | 'offline' | 'syncing' | 'pending' | 'synced';

export function deriveStatus(f: SyncFacts): SyncBadge {
  if (f.blocked) return f.blocked;
  if (f.unresolvedRejections > 0) return 'rejected';
  if (f.connection === 'offline') return 'offline';
  if (f.phase !== 'idle') return 'syncing';
  if (f.pendingCount > 0) return 'pending';
  return 'synced';
}

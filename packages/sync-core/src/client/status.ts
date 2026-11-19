export interface SyncFacts {
  connection: 'online' | 'offline' | 'unavailable';
  phase: 'idle' | 'pushing' | 'pulling' | 'resyncing';
  pendingCount: number;
  unresolvedRejections: number;
  blocked: null | 'upgrade' | 'auth' | 'error';
  storage: 'durable' | 'memory';
}

export type BlockReason = NonNullable<SyncFacts['blocked']>;

export type SyncBadge =
  | 'upgrade'
  | 'auth'
  | 'error'
  | 'offline'
  | 'unavailable'
  | 'syncing'
  | 'pending'
  | 'rejected'
  | 'synced';

// Rejections have their own inbox button, so they must not hide that the device is offline or still has changes to send.
export function deriveStatus(f: SyncFacts): SyncBadge {
  if (f.blocked) return f.blocked;
  if (f.connection !== 'online') return f.connection;
  if (f.phase !== 'idle') return 'syncing';
  if (f.pendingCount > 0) return 'pending';
  if (f.unresolvedRejections > 0) return 'rejected';
  return 'synced';
}

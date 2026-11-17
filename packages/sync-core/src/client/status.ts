/** Independent facts about the client; the UI derives one badge from them with `deriveStatus`. */
export interface SyncFacts {
  /** `offline` after a failed request, `online` after any successful one (`navigator.onLine` is only a hint). */
  connection: 'online' | 'offline';
  phase: 'idle' | 'pushing' | 'pulling' | 'resyncing';
  /** Local mutations the server has not acknowledged yet (including ones still being stored). */
  pendingCount: number;
  unresolvedRejections: number;
  /** Syncing stopped, queue kept: `auth` — sign in again; `upgrade` — load newer code; `error` — unexpected answer. */
  blocked: null | 'upgrade' | 'auth' | 'error';
  /** `memory`: durable storage could not be opened; nothing survives a reload. */
  storage: 'durable' | 'memory';
}

export type BlockReason = NonNullable<SyncFacts['blocked']>;

export type SyncBadge = 'upgrade' | 'auth' | 'error' | 'rejected' | 'offline' | 'syncing' | 'pending' | 'synced';

/** The one badge to show, by priority: blocked → rejected → offline → syncing → pending → synced. */
export function deriveStatus(f: SyncFacts): SyncBadge {
  if (f.blocked) return f.blocked;
  if (f.unresolvedRejections > 0) return 'rejected';
  if (f.connection === 'offline') return 'offline';
  if (f.phase !== 'idle') return 'syncing';
  if (f.pendingCount > 0) return 'pending';
  return 'synced';
}

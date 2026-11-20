import type { SyncFacts } from '../client/status';
import type { Change, Cursor } from '../protocol/types';

export type TabMessage =
  | { t: 'queue-changed' }
  /** With `pull`: a delta the leader committed from `from` to `to`; a tab at `from` applies it instead of reloading. */
  | { t: 'state-changed'; pull?: { from: Cursor | null; to: Cursor; changes: Change[] } }
  | { t: 'sync-request' }
  | { t: 'status'; facts: SyncFacts };

export interface TabCoordinator {
  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void;
  post(m: TabMessage): void;
  /** Gives up leadership for good while still exchanging messages: a blocked tab must not keep others from syncing. */
  resign(): void;
  close(): void;
}

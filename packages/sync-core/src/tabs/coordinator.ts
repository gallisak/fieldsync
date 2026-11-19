import type { SyncFacts } from '../client/status';

export type TabMessage =
  | { t: 'queue-changed' }
  | { t: 'state-changed' }
  | { t: 'sync-request' }
  | { t: 'status'; facts: SyncFacts };

export interface TabCoordinator {
  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void;
  post(m: TabMessage): void;
  /** Gives up leadership for good while still exchanging messages: a blocked tab must not keep others from syncing. */
  resign(): void;
  close(): void;
}

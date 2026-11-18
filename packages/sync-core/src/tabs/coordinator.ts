import type { SyncFacts } from '../client/status';

export type TabMessage =
  | { t: 'queue-changed' }
  | { t: 'state-changed' }
  | { t: 'sync-request' }
  | { t: 'status'; facts: SyncFacts };

/** Correctness never depends on the election: two leaders at once only cost duplicate requests. */
export interface TabCoordinator {
  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void;
  post(m: TabMessage): void;
  close(): void;
}

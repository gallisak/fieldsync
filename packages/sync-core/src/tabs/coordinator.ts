import type { SyncFacts } from '../client/status';

/** What tabs sharing one storage tell each other. */
export type TabMessage =
  | { t: 'queue-changed' } // a tab stored a new mutation
  | { t: 'state-changed' } // the leader committed a pull (or reset the client)
  | { t: 'sync-request' } // a follower wants the leader to sync
  | { t: 'status'; facts: SyncFacts }; // the leader's connection, phase and blocking, mirrored by followers

/**
 * Elects one tab to talk to the server and carries messages between tabs. Correctness never depends on it:
 * two leaders at once only cost duplicate requests (pushes are deduplicated by the server, overlapping pulls by
 * `commitPull`'s cursor check).
 */
export interface TabCoordinator {
  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void;
  /** Delivered to every other tab, never back to the sender. */
  post(m: TabMessage): void;
  /** Gives up leadership (the next tab takes over) and stops receiving messages. */
  close(): void;
}

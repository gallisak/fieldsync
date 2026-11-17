import type { EntityName, PullResponse, PushRequest, PushResponse, Row } from '../protocol/types';
import type { PullParams } from '../transport/http';

/** The user a request is authenticated as, in the server's shape. */
export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

/**
 * The server as the simulated network sees it: in memory (synchronous) or a real one (a promise). A response
 * the real server sends with a non-2xx status is thrown as `TransportError('http', status, code, details)`.
 */
export interface SyncServerPort {
  push(user: AuthUser, req: PushRequest): PushResponse | Promise<PushResponse>;
  pull(user: AuthUser, q: PullParams): PullResponse | Promise<PullResponse>;
}

/** A server a simulation can run against: the protocol, the admin operations it performs, what it checks. */
export interface SimServer extends SyncServerPort {
  /** `clientId/mutationId` of each application of a mutation, in order. */
  readonly applied: readonly string[];
  readonly rejectedCount: number;
  readonly lastVersion: number;
  addSite(siteId: string): void | Promise<void>;
  grant(userId: string, siteId: string): void | Promise<void>;
  revoke(userId: string, siteId: string): void | Promise<void>;
  gc(cut: number): void | Promise<void>;
  sitesOf(user: AuthUser): Set<string>;
  /** Live rows, in the order they were first written. */
  liveRows(entity?: EntityName): Row[];
  /** Per live part: the quantity it was added with plus every applied adjustment, each counted once. */
  expectedQuantities(): Map<string, number>;
  quantityOf(partId: string): number | undefined;
  /** Brings the reads above up to date; a server backed by a database loads them here. */
  refresh?(): Promise<void>;
}

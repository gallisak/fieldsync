import type { EntityName, PullResponse, PushRequest, PushResponse, Row } from '../protocol/types';
import type { PullParams } from '../transport/http';

export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

export interface SyncServerPort {
  push(user: AuthUser, req: PushRequest): PushResponse | Promise<PushResponse>;
  pull(user: AuthUser, q: PullParams): PullResponse | Promise<PullResponse>;
}

export interface SimServer extends SyncServerPort {
  readonly applied: readonly string[];
  readonly rejectedCount: number;
  readonly lastVersion: number;
  addSite(siteId: string): void | Promise<void>;
  grant(userId: string, siteId: string): void | Promise<void>;
  revoke(userId: string, siteId: string): void | Promise<void>;
  gc(cut: number): void | Promise<void>;
  sitesOf(user: AuthUser): Set<string>;
  liveRows(entity?: EntityName): Row[];
  expectedQuantities(): Map<string, number>;
  quantityOf(partId: string): number | undefined;
  refresh?(): Promise<void>;
  /** Drops the client row, as retention GC does for a client idle too long. */
  forgetClient?(clientId: string): void | Promise<void>;
}

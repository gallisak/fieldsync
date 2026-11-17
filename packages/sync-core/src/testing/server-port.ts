import type { PullResponse, PushRequest, PushResponse } from '../protocol/types';
import type { PullParams } from '../transport/http';

/** The user a request is authenticated as, in the server's shape. */
export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

/**
 * The server as the simulated network sees it. A response the real server sends with a non-2xx status is thrown
 * as `TransportError('http', status, code, details)`.
 */
export interface SyncServerPort {
  push(user: AuthUser, req: PushRequest): PushResponse;
  pull(user: AuthUser, q: PullParams): PullResponse;
}

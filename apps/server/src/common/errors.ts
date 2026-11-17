import type { ApiErrorCode } from '@fieldsync/sync-core';

/** An error the client is expected to act on; rendered as `{ code, message, details }` with `status`. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    readonly details?: unknown,
    message: string = code,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

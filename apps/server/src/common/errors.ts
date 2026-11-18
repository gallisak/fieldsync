import type { ApiErrorCode } from '@fieldsync/sync-core';

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

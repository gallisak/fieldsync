/** Request-level error codes (non-2xx envelope) that a client branches on. */
export type ApiErrorCode =
  | 'UPGRADE_REQUIRED'
  | 'UNAUTHENTICATED'
  | 'CLIENT_MISMATCH'
  | 'OUT_OF_ORDER'
  | 'BAD_REQUEST'
  | 'UNAVAILABLE';

/** Why a single mutation was rejected; travels in push results and pull rejections. */
export type RejectionCode =
  | 'BAD_ARGS'
  | 'NO_ACCESS'
  | 'ALREADY_EXISTS'
  | 'STATUS_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'NEGATIVE_QUANTITY'
  | 'INTERNAL'
  | 'QUEUE_FULL'; // client only: too many changes waiting to sync

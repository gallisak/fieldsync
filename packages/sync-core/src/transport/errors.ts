/**
 * Why a call to the server failed. `network`: no response at all; `timeout`: no response in time; `http`: a
 * non-2xx response, with the `{ code, message, details }` envelope when the server sent one.
 */
export class TransportError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'http',
    readonly status?: number,
    readonly code?: string,
    readonly details?: unknown,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? (kind === 'http' ? `HTTP ${status}${code ? ` ${code}` : ''}` : kind), options);
    this.name = 'TransportError';
  }
}

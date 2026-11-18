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

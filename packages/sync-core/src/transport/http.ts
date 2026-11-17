import type { Cursor, PullResponse, PushRequest, PushResponse } from '../protocol/types';
import { PROTOCOL, PROTOCOL_HEADER } from '../protocol/version';
import { TransportError } from './errors';

export interface PullParams {
  cursor: Cursor | null;
  clientId: string;
  /** Rejections of mutations up to this id are already known to the client and are not sent again. */
  ackedMutationId: number;
  limit: number;
}

/**
 * Both methods reject with a `TransportError`, or with the abort reason when `signal` aborts (the caller gave
 * up, e.g. on dispose).
 */
export interface Transport {
  push(req: PushRequest, signal?: AbortSignal): Promise<PushResponse>;
  pull(params: PullParams, signal?: AbortSignal): Promise<PullResponse>;
}

export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs = 20_000,
  ) {}

  push(req: PushRequest, signal?: AbortSignal): Promise<PushResponse> {
    return this.call<PushResponse>(
      '/sync/push',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
      signal,
    );
  }

  pull(params: PullParams, signal?: AbortSignal): Promise<PullResponse> {
    const qs = new URLSearchParams({
      clientId: params.clientId,
      ackedMutationId: String(params.ackedMutationId),
      limit: String(params.limit),
    });
    if (params.cursor) qs.set('cursor', params.cursor);
    return this.call<PullResponse>(`/sync/pull?${qs}`, {}, signal);
  }

  private async call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    // One controller per request: aborted by the caller's signal or by the timeout, whichever comes first.
    // Built by hand (not AbortSignal.any/timeout) so it works on older runtimes and leaves no timer behind.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: { ...init.headers, authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(PROTOCOL) },
        });
      } catch (err) {
        throw this.failure(err, timedOut, signal);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as
          | { code?: unknown; message?: unknown; details?: unknown }
          | undefined;
        throw new TransportError(
          'http',
          res.status,
          typeof body?.code === 'string' ? body.code : undefined,
          body?.details,
          typeof body?.message === 'string' ? body.message : undefined,
        );
      }
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw this.failure(err, timedOut, signal);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private failure(err: unknown, timedOut: boolean, signal?: AbortSignal): unknown {
    if (timedOut) return new TransportError('timeout', undefined, undefined, undefined, undefined, { cause: err });
    if (signal?.aborted) return signal.reason ?? err; // the caller gave up: not a transport failure
    return new TransportError('network', undefined, undefined, undefined, undefined, { cause: err });
  }
}

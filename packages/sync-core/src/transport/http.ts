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

/** Both methods reject with a `TransportError`. */
export interface Transport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(params: PullParams): Promise<PullResponse>;
}

export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  push(req: PushRequest): Promise<PushResponse> {
    return this.call<PushResponse>('/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  }

  pull(params: PullParams): Promise<PullResponse> {
    const qs = new URLSearchParams({
      clientId: params.clientId,
      ackedMutationId: String(params.ackedMutationId),
      limit: String(params.limit),
    });
    if (params.cursor) qs.set('cursor', params.cursor);
    return this.call<PullResponse>(`/sync/pull?${qs}`, {});
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(PROTOCOL) },
      });
    } catch (err) {
      throw new TransportError('network', undefined, undefined, undefined, undefined, { cause: err });
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
    return (await res.json()) as T;
  }
}

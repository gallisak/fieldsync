import type { Cursor, PullResponse, PushRequest, PushResponse } from '../protocol/types';
import { PROTOCOL, PROTOCOL_HEADER } from '../protocol/version';

export interface Transport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(cursor: Cursor | null, clientId: string, limit?: number): Promise<PullResponse>;
}

export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async push(req: PushRequest): Promise<PushResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        [PROTOCOL_HEADER]: String(PROTOCOL),
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`push failed: HTTP ${res.status}`);
    return (await res.json()) as PushResponse;
  }

  async pull(cursor: Cursor | null, clientId: string, limit = 500): Promise<PullResponse> {
    const qs = new URLSearchParams({ clientId, limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const res = await this.fetchImpl(`${this.baseUrl}/sync/pull?${qs}`, {
      headers: { authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(PROTOCOL) },
    });
    if (!res.ok) throw new Error(`pull failed: HTTP ${res.status}`);
    return (await res.json()) as PullResponse;
  }
}

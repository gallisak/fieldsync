import type { INestApplication } from '@nestjs/common';
import { PROTOCOL, PROTOCOL_HEADER, type Mutation, type Row } from '@fieldsync/sync-core';
import { randomUUID } from 'crypto';
import { request as httpRequest, type ClientRequest } from 'http';
import type { AddressInfo } from 'net';
import type { Pool } from 'pg';
import type request from 'supertest';
import { DEMO, seedDemo } from '../../src/seed';

type Http = ReturnType<typeof request>;

export const TOKENS = {
  admin: 'admin-token',
  techA: 'tech-a-token',
  techB: 'tech-b-token',
} as const;

export { DEMO };

export function seed(pool: Pool): Promise<void> {
  return seedDemo(pool);
}

export function push(http: Http, token: string, clientId: string, mutations: Mutation[]) {
  return http
    .post('/sync/push')
    .set('authorization', `Bearer ${token}`)
    .set(PROTOCOL_HEADER, String(PROTOCOL))
    .send({ clientId, mutations });
}

export function pull(
  http: Http,
  token: string,
  params: { cursor?: string | number; clientId?: string; limit?: number } = {},
) {
  const query: Record<string, string> = {};
  if (params.cursor !== undefined) query.cursor = String(params.cursor);
  if (params.clientId !== undefined) query.clientId = params.clientId;
  if (params.limit !== undefined) query.limit = String(params.limit);
  return http
    .get('/sync/pull')
    .set('authorization', `Bearer ${token}`)
    .set(PROTOCOL_HEADER, String(PROTOCOL))
    .query(query);
}

export function me(http: Http, token: string) {
  return http.get('/me').set('authorization', `Bearer ${token}`).set(PROTOCOL_HEADER, String(PROTOCOL));
}

/** Starts the app on an ephemeral port (needed for streams and for a real SyncClient) and returns its URL. */
export async function listen(app: INestApplication): Promise<string> {
  const server = app.getHttpServer();
  if (!server.listening) await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface OpenStream {
  status: number;
  req: ClientRequest;
  /** Everything the stream has sent so far. */
  received(): string;
}

/** Opens `GET /sync/stream` and resolves as soon as the response headers arrive; the body is left open. */
export function openStream(baseUrl: string, opts: { token?: string; query?: string } = {}): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}/sync/stream${opts.query ? `?${opts.query}` : ''}`, {
      headers: {
        [PROTOCOL_HEADER]: String(PROTOCOL),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
    });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      resolve({ status: res.statusCode ?? 0, req, received: () => body });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function liveRows(pool: Pool, entity: 'ticket' | 'part'): Promise<Row[]> {
  const { rows } = await pool.query<{ data: Row }>(
    `SELECT data FROM entities WHERE entity = $1 AND NOT deleted ORDER BY id`,
    [entity],
  );
  return rows.map((r) => r.data);
}

export function sortById(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Creates a ticket through the push endpoint and returns its id; throws unless the mutation was applied. */
export async function createTicket(
  http: Http,
  opts: { token: string; clientId: string; mutationId: number; siteId: string; title: string },
): Promise<string> {
  const id = randomUUID();
  const res = await push(http, opts.token, opts.clientId, [
    {
      id: opts.mutationId,
      name: 'ticket.create',
      args: { id, siteId: opts.siteId, title: opts.title, description: '' },
    },
  ]);
  if (res.status >= 300 || res.body.results?.[0]?.status !== 'applied') {
    throw new Error(`createTicket: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return id;
}

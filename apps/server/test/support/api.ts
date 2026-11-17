import type { INestApplication } from '@nestjs/common';
import type { Mutation, Row } from '@fieldsync/sync-core';
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

/** Two sites, an admin, techA on site A and techB on site B — the same rows as `src/seed.ts`. */
export function seed(pool: Pool): Promise<void> {
  return seedDemo(pool);
}

export function push(http: Http, token: string, clientId: string, mutations: Mutation[]) {
  return http.post('/sync/push').set('authorization', `Bearer ${token}`).send({ clientId, mutations });
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
  return http.get('/sync/pull').set('authorization', `Bearer ${token}`).query(query);
}

export function me(http: Http, token: string) {
  return http.get('/me').set('authorization', `Bearer ${token}`);
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
}

/** Opens `GET /sync/stream` and resolves as soon as the response headers arrive; the body is left open. */
export function openStream(baseUrl: string, opts: { token?: string; query?: string } = {}): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}/sync/stream${opts.query ? `?${opts.query}` : ''}`, {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, req });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Live (non-deleted) rows of one entity type, straight from the database. */
export async function liveRows(pool: Pool, entity: 'ticket' | 'part'): Promise<Row[]> {
  const { rows } = await pool.query<{ data: Row }>(
    `SELECT data FROM entities WHERE entity = $1 AND NOT deleted ORDER BY id`,
    [entity],
  );
  return rows.map((r) => r.data);
}

export function sortById(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Creates a ticket through the push endpoint and returns its id. The starter generates ticket ids on the
 * server (F17), so the id is looked up by its (unique per test) title.
 */
export async function createTicket(
  http: Http,
  pool: Pool,
  opts: { token: string; clientId: string; mutationId: number; siteId: string; title: string },
): Promise<string> {
  const res = await push(http, opts.token, opts.clientId, [
    { id: opts.mutationId, name: 'ticket.create', args: { siteId: opts.siteId, title: opts.title, description: '' } },
  ]);
  if (res.status >= 300) throw new Error(`createTicket: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`,
    [opts.title],
  );
  if (rows.length !== 1) throw new Error(`createTicket: expected one ticket titled ${opts.title}`);
  return rows[0].id;
}

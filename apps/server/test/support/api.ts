import type { Mutation } from '@fieldsync/sync-core';
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

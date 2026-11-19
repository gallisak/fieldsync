import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

export interface ClientRow {
  userId: string;
  lastMutationId: number;
}

@Injectable()
export class ClientRepository {
  // One statement that locks the row: with a separate insert and select, GC could delete the row in between.
  async lockOrCreate(c: PoolClient, clientId: string, userId: string): Promise<ClientRow> {
    const { rows } = await c.query<{ user_id: string; last_mutation_id: string }>(
      `INSERT INTO clients (client_id, user_id) VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET last_seen_at = clients.last_seen_at
       RETURNING user_id, last_mutation_id`,
      [clientId, userId],
    );
    return { userId: rows[0].user_id, lastMutationId: Number(rows[0].last_mutation_id) };
  }

  /** A client that only pulls is still in use: retention GC must not forget its acknowledgements. */
  async touch(q: Pool | PoolClient, clientId: string, userId: string): Promise<void> {
    await q.query(
      `UPDATE clients SET last_seen_at = now()
        WHERE client_id = $1 AND user_id = $2 AND last_seen_at < now() - interval '1 hour'`,
      [clientId, userId],
    );
  }

  async find(q: Pool | PoolClient, clientId: string): Promise<ClientRow | undefined> {
    const { rows } = await q.query<{ user_id: string; last_mutation_id: string }>(
      `SELECT user_id, last_mutation_id FROM clients WHERE client_id = $1`,
      [clientId],
    );
    return rows.length ? { userId: rows[0].user_id, lastMutationId: Number(rows[0].last_mutation_id) } : undefined;
  }

  async setLastMutationId(c: PoolClient, clientId: string, mutationId: number): Promise<void> {
    await c.query(`UPDATE clients SET last_mutation_id = $2, last_seen_at = now() WHERE client_id = $1`, [
      clientId,
      mutationId,
    ]);
  }

  async lastMutationId(q: Pool | PoolClient, clientId: string, userId: string): Promise<number> {
    const { rows } = await q.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1 AND user_id = $2`,
      [clientId, userId],
    );
    return rows.length ? Number(rows[0].last_mutation_id) : 0;
  }
}

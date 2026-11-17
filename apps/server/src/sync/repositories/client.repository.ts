import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

export interface ClientRow {
  userId: string;
  lastMutationId: number;
}

@Injectable()
export class ClientRepository {
  /** Creates the client row on first use and locks it: every push of one client queues on this lock (F4). */
  async lockOrCreate(c: PoolClient, clientId: string, userId: string): Promise<ClientRow> {
    await c.query(`INSERT INTO clients (client_id, user_id) VALUES ($1, $2) ON CONFLICT (client_id) DO NOTHING`, [
      clientId,
      userId,
    ]);
    const { rows } = await c.query<{ user_id: string; last_mutation_id: string }>(
      `SELECT user_id, last_mutation_id FROM clients WHERE client_id = $1 FOR UPDATE`,
      [clientId],
    );
    return { userId: rows[0].user_id, lastMutationId: Number(rows[0].last_mutation_id) };
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

  /** 0 when the client does not exist or belongs to another user. */
  async lastMutationId(q: Pool | PoolClient, clientId: string, userId: string): Promise<number> {
    const { rows } = await q.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1 AND user_id = $2`,
      [clientId, userId],
    );
    return rows.length ? Number(rows[0].last_mutation_id) : 0;
  }
}

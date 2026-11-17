import { Injectable } from '@nestjs/common';
import type { PulledRejection, RejectionCode } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';

export interface Rejection {
  code: RejectionCode;
  message: string;
  details?: unknown;
}

interface RejectionRow {
  mutation_id: string;
  code: RejectionCode;
  message: string;
  details: unknown;
}

const toRejection = (r: RejectionRow): Rejection => ({
  code: r.code,
  message: r.message,
  ...(r.details === null ? {} : { details: r.details }),
});

@Injectable()
export class RejectionRepository {
  async insert(c: PoolClient, clientId: string, mutationId: number, r: Rejection): Promise<void> {
    await c.query(
      `INSERT INTO mutation_rejections (client_id, mutation_id, code, message, details) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, mutationId, r.code, r.message, r.details === undefined ? null : JSON.stringify(r.details)],
    );
  }

  async find(c: PoolClient, clientId: string, mutationId: number): Promise<Rejection | undefined> {
    const { rows } = await c.query<RejectionRow>(
      `SELECT mutation_id, code, message, details FROM mutation_rejections WHERE client_id = $1 AND mutation_id = $2`,
      [clientId, mutationId],
    );
    return rows.length ? toRejection(rows[0]) : undefined;
  }

  async listAfter(c: PoolClient, clientId: string, ackedMutationId: number): Promise<PulledRejection[]> {
    const { rows } = await c.query<RejectionRow>(
      `SELECT mutation_id, code, message, details FROM mutation_rejections
        WHERE client_id = $1 AND mutation_id > $2 ORDER BY mutation_id`,
      [clientId, ackedMutationId],
    );
    return rows.map((r) => ({ mutationId: Number(r.mutation_id), ...toRejection(r) }));
  }
}

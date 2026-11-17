import { BadRequestException, Injectable } from '@nestjs/common';
import type { MutationResult, PushRequest, PushResponse } from '@fieldsync/sync-core';
import type { AuthUser } from './auth';
import { Db } from './db';
import { applyMutation } from './server-tx';
import { StreamService } from './stream.service';

@Injectable()
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
  ) {}

  async push(user: AuthUser, req: PushRequest): Promise<PushResponse> {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      const last = await this.lastMutationId(req.clientId);
      if (m.id <= last) {
        results.push({ id: m.id, status: 'duplicate' });
        continue;
      }
      if (m.id !== last + 1) {
        throw new BadRequestException(`Out-of-order mutation ${m.id}, expected ${last + 1}`);
      }
      const touched = await this.db.tx(async (c) => {
        const sites = await applyMutation(c, user, m);
        await c.query(
          `INSERT INTO clients (client_id, user_id, last_mutation_id) VALUES ($1, $2, $3)
           ON CONFLICT (client_id) DO UPDATE SET last_mutation_id = $3`,
          [req.clientId, user.id, m.id],
        );
        return sites;
      });
      this.streams.notify(touched);
      results.push({ id: m.id, status: 'applied' });
    }
    return { results, lastMutationId: await this.lastMutationId(req.clientId) };
  }

  async lastMutationId(clientId: string): Promise<number> {
    const { rows } = await this.db.pool.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
      [clientId],
    );
    return rows.length ? Number(rows[0].last_mutation_id) : 0;
  }
}

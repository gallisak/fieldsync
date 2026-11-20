import { Injectable } from '@nestjs/common';
import {
  MutationRejected,
  type Mutation,
  type MutationResult,
  type PushRequest,
  type PushResponse,
} from '@fieldsync/sync-core';
import { PinoLogger } from 'nestjs-pino';
import type { PoolClient } from 'pg';
import type { AuthUser } from './auth/auth.guard';
import { ApiError } from './common/errors';
import { withContext } from './common/request-context';
import { MetricsService } from './observability/metrics.service';
import { Db, isOperational } from './database/db.service';
import { MutationExecutor } from './sync/push/mutation-executor';
import { ClientRepository } from './sync/repositories/client.repository';
import { RejectionRepository, type Rejection } from './sync/repositories/rejection.repository';
import { StreamService } from './stream.service';

@Injectable()
export class PushService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly db: Db,
    private readonly streams: StreamService,
    private readonly executor: MutationExecutor,
    private readonly clients: ClientRepository,
    private readonly rejections: RejectionRepository,
    private readonly metrics: MetricsService,
  ) {
    logger.setContext(PushService.name);
  }

  async push(user: AuthUser, req: PushRequest): Promise<PushResponse> {
    const results: MutationResult[] = [];
    const changed = new Set<string>();
    let lastMutationId: number | undefined;
    try {
      for (const m of req.mutations) {
        const { result, sites, last } = await withContext({ clientId: req.clientId, mutationId: m.id }, async () => {
          const started = performance.now();
          const applied = await this.applyOne(user, req.clientId, m);
          const { status, code } = applied.result;
          this.metrics.mutations.inc({ status });
          if (code && status === 'rejected') this.metrics.rejected.inc({ code });
          this.logger.info({ status, code, durationMs: Math.round(performance.now() - started) }, 'mutation');
          return applied;
        });
        for (const s of sites) changed.add(s);
        results.push(result);
        lastMutationId = last;
      }
    } finally {
      // Also when a later mutation failed: the earlier ones are committed.
      if (changed.size) this.streams.notify([...changed]);
    }
    return {
      results,
      lastMutationId: lastMutationId ?? (await this.clients.lastMutationId(this.db.pool, req.clientId, user.id)),
    };
  }

  private applyOne(
    user: AuthUser,
    clientId: string,
    m: Mutation,
  ): Promise<{ result: MutationResult; sites: string[]; last: number }> {
    return this.db.tx(async (c) => {
      const client = await this.clients.lockOrCreate(c, clientId, user.id);
      if (client.userId !== user.id) {
        throw new ApiError('CLIENT_MISMATCH', 403, undefined, 'clientId belongs to another user');
      }
      if (m.id <= client.lastMutationId) {
        return { result: await this.duplicate(c, clientId, m.id), sites: [], last: client.lastMutationId };
      }
      const expected = client.lastMutationId + 1;
      if (m.id !== expected) throw new ApiError('OUT_OF_ORDER', 409, { expected }, `Expected mutation ${expected}`);

      let result: MutationResult;
      let sites: string[] = [];
      // Before the savepoint, so a rejection keeps it; and before the executor takes the sync_state lock, which every
      // writer waits for until this transaction commits.
      await this.clients.setLastMutationId(c, clientId, m.id);
      await c.query('SAVEPOINT m');
      try {
        sites = await this.executor.execute(c, user, m, clientId);
        result = { id: m.id, status: 'applied' };
      } catch (err) {
        if (!(err instanceof MutationRejected) && isOperational(err)) throw err;
        await c.query('ROLLBACK TO SAVEPOINT m');
        const rejection = this.toRejection(err, m);
        await this.rejections.insert(c, clientId, m.id, rejection);
        result = { id: m.id, status: 'rejected', ...rejection };
      }
      return { result, sites, last: m.id };
    });
  }

  private async duplicate(c: PoolClient, clientId: string, id: number): Promise<MutationResult> {
    const rejection = await this.rejections.find(c, clientId, id);
    return { id, status: 'duplicate', ...rejection };
  }

  private toRejection(err: unknown, m: Mutation): Rejection {
    if (err instanceof MutationRejected) {
      return { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) };
    }
    this.logger.error({ err, mutator: m.name }, 'mutation failed');
    return { code: 'INTERNAL', message: 'Unexpected server error' };
  }
}

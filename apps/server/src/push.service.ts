import { Injectable, Logger } from '@nestjs/common';
import {
  MutationRejected,
  type Mutation,
  type MutationResult,
  type PushRequest,
  type PushResponse,
} from '@fieldsync/sync-core';
import { ZodError } from 'zod';
import type { PoolClient } from 'pg';
import type { AuthUser } from './auth/auth.guard';
import { ApiError } from './common/errors';
import { Db, isTransient } from './database/db.service';
import { MutationExecutor } from './sync/push/mutation-executor';
import { ClientRepository } from './sync/repositories/client.repository';
import { RejectionRepository, type Rejection } from './sync/repositories/rejection.repository';
import { StreamService } from './stream.service';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
    private readonly executor: MutationExecutor,
    private readonly clients: ClientRepository,
    private readonly rejections: RejectionRepository,
  ) {}

  async push(user: AuthUser, req: PushRequest): Promise<PushResponse> {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      const { result, sites } = await this.applyOne(user, req.clientId, m);
      if (sites.length) this.streams.notify(sites);
      results.push(result);
    }
    return { results, lastMutationId: await this.clients.lastMutationId(this.db.pool, req.clientId, user.id) };
  }

  private applyOne(
    user: AuthUser,
    clientId: string,
    m: Mutation,
  ): Promise<{ result: MutationResult; sites: string[] }> {
    return this.db.tx(async (c) => {
      const client = await this.clients.lockOrCreate(c, clientId, user.id);
      if (client.userId !== user.id) {
        throw new ApiError('CLIENT_MISMATCH', 403, undefined, 'clientId belongs to another user');
      }
      if (m.id <= client.lastMutationId) return { result: await this.duplicate(c, clientId, m.id), sites: [] };
      const expected = client.lastMutationId + 1;
      if (m.id !== expected) throw new ApiError('OUT_OF_ORDER', 409, { expected }, `Expected mutation ${expected}`);

      let result: MutationResult;
      let sites: string[] = [];
      await c.query('SAVEPOINT m');
      try {
        sites = await this.executor.execute(c, user, m, clientId);
        result = { id: m.id, status: 'applied' };
      } catch (err) {
        if (isTransient(err)) throw err;
        await c.query('ROLLBACK TO SAVEPOINT m');
        const rejection = this.toRejection(err, m);
        await this.rejections.insert(c, clientId, m.id, rejection);
        result = { id: m.id, status: 'rejected', ...rejection };
      }
      // Advanced for rejected mutations too: a rejection must not block the mutations queued behind it (F5).
      await this.clients.setLastMutationId(c, clientId, m.id);
      return { result, sites };
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
    if (err instanceof ZodError) {
      return { code: 'BAD_ARGS', message: err.issues[0]?.message ?? 'Invalid arguments', details: err.issues };
    }
    this.logger.error(
      `mutation ${m.id} (${m.name}) failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return { code: 'INTERNAL', message: 'Unexpected server error' };
  }
}

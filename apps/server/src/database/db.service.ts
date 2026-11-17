import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { seedDemo } from '../seed';
import { migrate } from './migrator';

export interface TxOptions {
  isolation?: 'repeatable read';
  readOnly?: boolean;
}

/** serialization_failure, deadlock_detected, admin_shutdown. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '57P01']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
const MAX_RETRIES = 3;

/**
 * Errors after which the whole transaction can safely be run again; they say nothing about the request
 * itself. Class 08 is connection_exception; node-postgres reports a dropped or timed-out connection without
 * any code.
 */
export function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || NETWORK_CODES.has(code);
  return err instanceof Error && /Connection terminated|timeout exceeded when trying to connect/i.test(err.message);
}

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;
  private readonly logger = new Logger(Db.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
    // node-postgres reports a connection that Postgres dropped as an 'error' event, which kills the process
    // when nobody listens (F28). The pool already discards the dead client; queries on it fail on their own.
    this.pool.on('error', (err) => this.logger.warn(`idle database connection lost: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await migrate(this.pool);
    if (this.config.SEED_DEMO) await seedDemo(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** Runs `fn` in one transaction; `fn` may run more than once, so it must not have side effects outside it. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    let begin = 'BEGIN';
    if (opts.isolation) begin += ` ISOLATION LEVEL ${opts.isolation.toUpperCase()}`;
    if (opts.readOnly) begin += ' READ ONLY';

    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      // While checked out, the client's 'error' event is ours to handle (the pool listens only to idle ones).
      const onLost = (err: Error) => this.logger.warn(`database connection lost during a transaction: ${err.message}`);
      client.on('error', onLost);
      let broken = false;
      try {
        await client.query(begin);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // a dead connection must not hide the original error
        }
        if (isTransient(err) && attempt < MAX_RETRIES) continue;
        throw err;
      } finally {
        client.off('error', onLost);
        client.release(broken);
      }
    }
  }
}

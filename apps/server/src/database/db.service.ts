import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { seedDemo } from '../seed';
import { migrate } from './migrator';

export interface TxOptions {
  isolation?: 'repeatable read';
  readOnly?: boolean;
}

/** serialization_failure, deadlock_detected: the whole transaction can safely be run again. */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_RETRIES = 3;

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
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
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE.has(code) && attempt < MAX_RETRIES) continue;
        throw err;
      } finally {
        client.release(broken);
      }
    }
  }
}

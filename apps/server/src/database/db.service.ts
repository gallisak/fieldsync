import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { seedDemo } from '../seed';
import { migrate } from './migrator';

export interface TxOptions {
  isolation?: 'repeatable read';
  readOnly?: boolean;
}

const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57P01', '57P02', '57P03', '53300']);
// SQLSTATE classes about the database's state, not the mutation: the same request can succeed later.
const OPERATIONAL_CLASSES = new Set(['08', '40', '53', '55', '57', '58', 'XX']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 20;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || NETWORK_CODES.has(code);
  return err instanceof Error && /Connection terminated|timeout exceeded when trying to connect/i.test(err.message);
}

const isPoolTimeout = (err: unknown) => err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);

export function isOperational(err: unknown): boolean {
  if (isTransient(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && OPERATIONAL_CLASSES.has(code.slice(0, 2));
}

@Injectable()
export class Db implements OnModuleInit, OnApplicationShutdown {
  readonly pool: Pool;
  private readonly logger = new Logger(Db.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    // Without a listener, the 'error' event of a connection Postgres dropped kills the process (F28).
    this.pool.on('error', (err) => this.logger.warn(`idle database connection lost: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await migrate(this.pool);
    if (this.config.SEED_DEMO) await seedDemo(this.pool);
  }

  // Runs after the HTTP server has stopped and its requests have finished; destroy hooks run before that.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /** Runs `fn` in one transaction; `fn` may run more than once, so it must not have side effects outside it. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    let begin = 'BEGIN';
    if (opts.isolation) begin += ` ISOLATION LEVEL ${opts.isolation.toUpperCase()}`;
    if (opts.readOnly) begin += ' READ ONLY';

    for (let attempt = 0; ; attempt++) {
      // Jittered: transactions that just collided, or a database short of connections, should not meet again at once.
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_BASE_MS * 2 ** attempt));
      let client: PoolClient;
      try {
        client = await this.pool.connect();
      } catch (err) {
        // A full pool already made this request wait the whole timeout; waiting again would outlast the client's.
        if (isTransient(err) && !isPoolTimeout(err) && attempt < MAX_RETRIES) continue;
        throw err;
      }
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
          broken = true;
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

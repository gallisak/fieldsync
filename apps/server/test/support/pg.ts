import 'reflect-metadata';
import { randomBytes } from 'crypto';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, parseConfig } from '../../src/config/env';
import { Db } from '../../src/database/db.service';

/**
 * Returns DATABASE_URL. In CI a missing URL is a hard error, so integration suites can never be
 * skipped silently; locally it returns undefined and the suites are skipped.
 */
export function requireDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.CI) throw new Error('DATABASE_URL is required in CI');
  return url || undefined;
}

export function describeDb(name: string, fn: () => void): void {
  (requireDatabaseUrl() ? describe : describe.skip)(name, fn);
}

/** Polls `condition` every 20 ms; a timeout is a setup failure, not a test result. */
export async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`setup: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Number of backends waiting, directly or through a chain, on a lock held by `pid`. Must run outside any
 * transaction: pg_stat_activity is snapshotted once per transaction.
 */
export async function waitersOn(pool: Pool, pid: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `WITH RECURSIVE w(pid) AS (
       SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
       UNION
       SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))
     ) SELECT count(*)::int AS n FROM w`,
    [pid],
  );
  return rows[0].n;
}

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  /** The application's own pool; its search_path points at this test's private schema. */
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

/**
 * Boots the full AppModule against a fresh, empty Postgres schema. Each call gets its own schema,
 * so test files can run in parallel without seeing each other's rows. `env` overrides configuration
 * (for example DB_POOL_MAX); `logger` receives the app's log output, which is off by default.
 */
export async function createTestApp(
  env: Record<string, string> = {},
  opts: { logger?: LoggerService } = {},
): Promise<TestApp> {
  const connectionString = requireDatabaseUrl();
  if (!connectionString) throw new Error('createTestApp() needs DATABASE_URL');

  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  // libpq `options` in the URL pins every pooled connection to the private schema.
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const config = parseConfig({ ...env, DATABASE_URL: url.toString(), SEED_DEMO: 'false' });

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    const app = moduleRef.createNestApplication({ logger: opts.logger ?? false });
    await app.init();

    return {
      app,
      http: request(app.getHttpServer()),
      pool: app.get(Db).pool,
      schema,
      async close() {
        try {
          await app.close();
        } finally {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
      },
    };
  } catch (err) {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw err;
  }
}

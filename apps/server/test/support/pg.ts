import 'reflect-metadata';
import { randomBytes } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { LOG_DESTINATION } from '../../src/common/logging';
import { APP_CONFIG, parseConfig } from '../../src/config/env';
import { Db } from '../../src/database/db.service';

export function requireDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.CI) throw new Error('DATABASE_URL is required in CI');
  return url || undefined;
}

export function describeDb(name: string, fn: () => void): void {
  (requireDatabaseUrl() ? describe : describe.skip)(name, fn);
}

export async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`setup: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Must run outside a transaction: pg_stat_activity is snapshotted once per transaction. */
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
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  opts: { logs?: Record<string, unknown>[] } = {},
): Promise<TestApp> {
  const connectionString = requireDatabaseUrl();
  if (!connectionString) throw new Error('createTestApp() needs DATABASE_URL');

  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const config = parseConfig({
    LOG_LEVEL: opts.logs ? 'info' : 'silent',
    ...env,
    DATABASE_URL: url.toString(),
    SEED_DEMO: 'false',
  });

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (line: string) => void opts.logs?.push(JSON.parse(line)) })
      .compile();
    const app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
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

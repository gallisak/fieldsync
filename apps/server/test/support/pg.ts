import 'reflect-metadata';
import { randomBytes } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { Db } from '../../src/db';

/**
 * Returns DATABASE_URL. In CI a missing URL is a hard error, so integration suites can never be
 * skipped silently; locally it returns undefined and the suites are skipped.
 */
export function requireDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.CI) throw new Error('DATABASE_URL is required in CI');
  return url || undefined;
}

/** `describe` when a database is available, `describe.skip` otherwise. */
export function describeDb(name: string, fn: () => void): void {
  (requireDatabaseUrl() ? describe : describe.skip)(name, fn);
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
 * so test files can run in parallel without seeing each other's rows.
 */
export async function createTestApp(): Promise<TestApp> {
  const connectionString = requireDatabaseUrl();
  if (!connectionString) throw new Error('createTestApp() needs DATABASE_URL');

  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const pool = new Pool({ connectionString, max: 20, options: `-c search_path=${schema}` });
  // Db creates its pool in a field initializer, so build the instance without running it and
  // attach the schema-scoped pool instead. Lifecycle hooks (schema DDL, pool.end) still run.
  const db = Object.create(Db.prototype) as Db;
  Object.defineProperty(db, 'pool', { value: pool });

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Db)
      .useValue(db)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    return {
      app,
      http: request(app.getHttpServer()),
      pool,
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
    await pool.end().catch(() => undefined);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw err;
  }
}

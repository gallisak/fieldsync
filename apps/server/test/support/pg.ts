import 'reflect-metadata';
import { randomBytes } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, parseConfig } from '../../src/config/env';
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

  // libpq `options` in the URL pins every pooled connection to the private schema.
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const config = parseConfig({ DATABASE_URL: url.toString(), SEED_DEMO: 'false' });

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
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

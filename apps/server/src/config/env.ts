import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { parseEnv } from 'util';
import { STREAM_WATCHDOG_MS } from '@fieldsync/sync-core';
import { z } from 'zod';

export const ENV_FILE = resolve(__dirname, '../../../../.env');

export function readEnvFile(path: string = ENV_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

const unset = (v: unknown) => (v === '' ? undefined : v);

// Digits only: Number() would also read 1e3, 0x10 and ' 7 '.
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    unset,
    z
      .string()
      .regex(/^\d+$/, 'must be a whole number')
      .transform(Number)
      .pipe(z.number().int().min(min).max(max))
      .default(def),
  );

// setInterval treats a longer delay as 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;
// The client drops a stream silent for longer than its watchdog; half of it survives one lost heartbeat.
const MAX_HEARTBEAT_MS = Math.floor(STREAM_WATCHDOG_MS / 2);

const isOrigin = (s: string) => {
  try {
    return new URL(s).origin === s;
  } catch {
    return false;
  }
};

const bool = (def: boolean) =>
  z.preprocess(
    unset,
    z
      .enum(['true', 'false', '1', '0'], { error: 'must be one of true, false, 1, 0' })
      .default(def ? 'true' : 'false')
      .transform((v) => v === 'true' || v === '1'),
  );

const envSchema = z.object({
  PORT: int(3001, 1, 65_535),
  DATABASE_URL: z
    .string({ error: 'is required' })
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  DB_POOL_MAX: int(20, 1),
  SEED_DEMO: bool(false),
  CORS_ORIGINS: z.preprocess(
    unset,
    z
      .string()
      .default('http://localhost:3000,http://127.0.0.1:3000')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      // The browser sends the bare origin; '*', a path or a trailing slash would match no request.
      .pipe(z.array(z.string().refine(isOrigin, 'each entry must be an origin such as https://app.example.com')).min(1)),
  ),
  CHANGELOG_RETENTION_SECONDS: int(604_800, 1),
  CLIENT_RETENTION_DAYS: int(90, 1),
  GC_INTERVAL_MS: int(3_600_000, 1, MAX_TIMER_MS),
  STREAM_HEARTBEAT_MS: int(25_000, 1, MAX_HEARTBEAT_MS),
  STREAM_MAX_PER_USER: int(10, 1),
  LOG_LEVEL: z.preprocess(
    unset,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  METRICS_TOKEN: z.preprocess(unset, z.string().default('')),
}).superRefine((env, ctx) => {
  // A client still within the log must keep its row, or its next push is deduplicated against nothing.
  if (env.CLIENT_RETENTION_DAYS * 86_400 <= env.CHANGELOG_RETENTION_SECONDS) {
    ctx.addIssue({ code: 'custom', path: ['CLIENT_RETENTION_DAYS'], message: 'must outlast CHANGELOG_RETENTION_SECONDS' });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid server configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  cached ??= parseConfig({ ...readEnvFile(), ...process.env });
  return cached;
}

import { z } from 'zod';

/** Treat empty strings (e.g. `FOO=` in an .env file) as "not set" so defaults apply. */
const unset = (v: unknown) => (v === '' ? undefined : v);

const int = (def: number, min = 0) => z.preprocess(unset, z.coerce.number().int().min(min).default(def));

const bool = (def: boolean) =>
  z.preprocess(
    unset,
    z
      .enum(['true', 'false', '1', '0'], { error: 'must be one of true, false, 1, 0' })
      .default(def ? 'true' : 'false')
      .transform((v) => v === 'true' || v === '1'),
  );

const envSchema = z.object({
  PORT: int(3001, 1),
  DATABASE_URL: z
    .string({ error: 'is required' })
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  DB_POOL_MAX: int(20, 1),
  SEED_DEMO: bool(false),
  CORS_ORIGINS: z.preprocess(
    unset,
    z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  ),
  CHANGELOG_RETENTION_SECONDS: int(604_800, 1),
  CLIENT_RETENTION_DAYS: int(90, 1),
  GC_INTERVAL_MS: int(3_600_000, 1),
  STREAM_HEARTBEAT_MS: int(25_000, 1),
  STREAM_MAX_PER_USER: int(10, 1),
  LOG_LEVEL: z.preprocess(
    unset,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  METRICS_TOKEN: z.preprocess(unset, z.string().default('')),
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

/** Memoised: the only place in the server that reads `process.env`. */
export function loadConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

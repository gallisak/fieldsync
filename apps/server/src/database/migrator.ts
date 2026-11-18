import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Pool } from 'pg';

const LOCK_KEY = 727001;

export async function migrate(pool: Pool, dir = join(__dirname, 'migrations')): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialises concurrently booting instances; session-level, so it spans the per-file transactions.
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await c.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const { rows } = await c.query<{ name: string }>('SELECT name FROM schema_migrations');
      const done = new Set(rows.map((r) => r.name));
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(join(dir, file), 'utf8');
        await c.query('BEGIN');
        try {
          await c.query(sql);
          await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        applied.push(file);
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    c.release();
  }
  return applied;
}

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Pool } from 'pg';

const LOCK_KEY = 727001;

const MIGRATIONS = join(__dirname, 'migrations');

const migrationFiles = async (dir: string) => (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

export async function lastMigration(dir = MIGRATIONS): Promise<string> {
  return (await migrationFiles(dir)).at(-1) ?? '';
}

export async function migrate(pool: Pool, dir = MIGRATIONS): Promise<string[]> {
  const files = await migrationFiles(dir);
  const c = await pool.connect();
  const applied: string[] = [];
  let broken = false;
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
      // Must not hide the migration's own error; dropping the connection releases the lock as well.
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {
        broken = true;
      });
    }
  } finally {
    c.release(broken);
  }
  return applied;
}

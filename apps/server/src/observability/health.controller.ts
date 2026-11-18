import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../database/db.service';
import { lastMigration } from '../database/migrator';

@Controller()
export class HealthController {
  private migration?: Promise<string>;

  constructor(private readonly db: Db) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      const { rows } = await this.db.pool.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS ok`,
        [await (this.migration ??= lastMigration())],
      );
      if (rows[0].ok) return { status: 'ready' };
    } catch {
      // the database is unreachable: not ready
    }
    res.status(503);
    return { status: 'not ready' };
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db } from './db';

@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db) {}

  onModuleInit(): void {
    const every = Number(process.env.GC_INTERVAL_MS ?? 3_600_000);
    this.timer = setInterval(() => void this.collect().catch((e: Error) => this.logger.error(e.message)), every);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async collect(): Promise<number> {
    const retention = Number(process.env.CHANGELOG_RETENTION_SECONDS ?? 604_800);
    const res = await this.db.pool.query(`DELETE FROM change_log WHERE created_at < now() - make_interval(secs => $1)`, [
      retention,
    ]);
    return res.rowCount ?? 0;
  }
}

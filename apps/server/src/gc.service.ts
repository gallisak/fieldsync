import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/env';
import { Db } from './db';

@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.GC_INTERVAL_MS;
    this.timer = setInterval(() => void this.collect().catch((e: Error) => this.logger.error(e.message)), every);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async collect(): Promise<number> {
    const retention = this.config.CHANGELOG_RETENTION_SECONDS;
    const res = await this.db.pool.query(`DELETE FROM change_log WHERE created_at < now() - make_interval(secs => $1)`, [
      retention,
    ]);
    return res.rowCount ?? 0;
  }
}

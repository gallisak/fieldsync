import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/env';
import { Db } from './database/db.service';
import { MetricsService } from './observability/metrics.service';

const GC_LOCK = 727002;

export interface GcResult {
  cut: number | null;
  log: number;
  tombstones: number;
  rejections: number;
  clients: number;
}

@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.GC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** `null` when another run holds the lock. */
  async collect(
    cutoff: Date = new Date(Date.now() - this.config.CHANGELOG_RETENTION_SECONDS * 1000),
  ): Promise<GcResult | null> {
    const days = this.config.CLIENT_RETENTION_DAYS;
    const result = await this.db.tx(async (c): Promise<GcResult | null> => {
      // Per schema: a run in one schema must not make another schema's run skip.
      const lock = await c.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock($1, hashtext(current_schema())) AS ok`,
        [GC_LOCK],
      );
      if (!lock.rows[0].ok) return null;
      const found = await c.query<{ cut: string | null }>(
        `SELECT max(version) AS cut FROM change_log WHERE created_at < $1`,
        [cutoff],
      );
      const cut = found.rows[0].cut === null ? null : Number(found.rows[0].cut);

      let log = 0;
      let tombstones = 0;
      if (cut !== null) {
        log = (await c.query(`DELETE FROM change_log WHERE version <= $1`, [cut])).rowCount ?? 0;
        tombstones = (await c.query(`DELETE FROM entities WHERE deleted AND version <= $1`, [cut])).rowCount ?? 0;
      }
      // Kept as long as the client row, not the log: a client offline past the log's retention must still learn
      // why its mutation was refused, or it would drop the mutation as applied.
      const rejections = await c.query(
        `DELETE FROM mutation_rejections WHERE created_at < now() - make_interval(days => $1)`,
        [days],
      );
      const clients = await c.query(`DELETE FROM clients WHERE last_seen_at < now() - make_interval(days => $1)`, [
        days,
      ]);
      if (cut !== null) {
        // Last: writers lock sync_state last and hold it to COMMIT, so taking it earlier would stall every push.
        await c.query(`UPDATE sync_state SET min_retained_version = GREATEST(min_retained_version, $1)`, [cut]);
      }
      return { cut, log, tombstones, rejections: rejections.rowCount ?? 0, clients: clients.rowCount ?? 0 };
    });
    if (result) this.metrics.gcDeleted.inc(result.log + result.tombstones + result.rejections + result.clients);
    return result;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.collect();
    } catch (e) {
      this.logger.error((e as Error).message);
    } finally {
      this.running = false;
    }
  }
}

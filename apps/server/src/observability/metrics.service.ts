import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Db } from '../database/db.service';
import { StreamService } from '../stream.service';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly mutations = new Counter({
    name: 'fieldsync_mutations_total',
    help: 'Mutations handled by push, by outcome',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly rejected = new Counter({
    name: 'fieldsync_mutations_rejected_total',
    help: 'Rejected mutations, by rejection code',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  readonly pushDuration = new Histogram({
    name: 'fieldsync_push_duration_seconds',
    help: 'Duration of push requests',
    registers: [this.registry],
  });

  readonly pullDuration = new Histogram({
    name: 'fieldsync_pull_duration_seconds',
    help: 'Duration of pull requests, by answer mode',
    labelNames: ['mode'] as const,
    registers: [this.registry],
  });

  readonly deliveryLag = new Histogram({
    name: 'fieldsync_delivery_lag_seconds',
    help: 'Time from writing a change to delivering it to another client in a pull (each delivery)',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 3600],
    registers: [this.registry],
  });

  readonly fullResyncs = new Counter({
    name: 'fieldsync_full_resyncs_total',
    help: 'Snapshots started, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly gcDeleted = new Counter({
    name: 'fieldsync_gc_deleted_rows_total',
    help: 'Rows deleted by change-log GC',
    registers: [this.registry],
  });

  constructor(db: Db, streams: StreamService) {
    collectDefaultMetrics({ register: this.registry });
    new Gauge({
      name: 'fieldsync_active_streams',
      help: 'Open poke streams',
      registers: [this.registry],
      collect() {
        this.set(streams.count);
      },
    });
    new Gauge({
      name: 'fieldsync_change_log_rows',
      help: 'Change-log rows retained (last_version - min_retained_version)',
      registers: [this.registry],
      // Without the database it keeps its last value, and the rest of /metrics is still served.
      async collect() {
        try {
          const { rows } = await db.pool.query<{ n: string }>(
            `SELECT last_version - min_retained_version AS n FROM sync_state`,
          );
          this.set(Number(rows[0].n));
        } catch {
          return;
        }
      },
    });
  }
}

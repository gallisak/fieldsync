import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { PullResponse } from '@fieldsync/sync-core';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class SyncMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const path = ctx.switchToHttp().getRequest<Request>().route?.path;
    const started = process.hrtime.bigint();
    const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
    const observe = (body?: unknown) => {
      if (path === '/sync/push') this.metrics.pushDuration.observe(seconds());
      if (path === '/sync/pull') {
        this.metrics.pullDuration.observe({ mode: (body as PullResponse | undefined)?.mode ?? 'error' }, seconds());
      }
    };
    return next.handle().pipe(tap({ next: observe, error: () => observe() }));
  }
}

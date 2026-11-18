import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccessAdminController } from './access/access.admin.controller';
import { AccessService } from './access/access.service';
import { AuthGuard } from './auth/auth.guard';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { loggerModule } from './common/logging';
import { requestContext, requestIdOf } from './common/request-context';
import { ConfigModule } from './config/config.module';
import { Db } from './database/db.service';
import { GcService } from './gc.service';
import { HealthController } from './observability/health.controller';
import { MetricsController } from './observability/metrics.controller';
import { SyncMetricsInterceptor } from './observability/metrics.interceptor';
import { MetricsService } from './observability/metrics.service';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { ClientRepository } from './sync/repositories/client.repository';
import { EntityRepository } from './sync/repositories/entity.repository';
import { RejectionRepository } from './sync/repositories/rejection.repository';
import { SnapshotService } from './sync/pull/snapshot.service';
import { MutationExecutor } from './sync/push/mutation-executor';
import { ChangeLogRepository } from './sync/repositories/change-log.repository';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [ConfigModule, loggerModule],
  controllers: [SyncController, StreamController, AccessAdminController, HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    Db,
    AuthGuard,
    AccessService,
    PushService,
    MutationExecutor,
    ChangeLogRepository,
    EntityRepository,
    ClientRepository,
    RejectionRepository,
    SnapshotService,
    PullService,
    StreamService,
    GcService,
    MetricsService,
    SyncMetricsInterceptor,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: Parameters<typeof requestIdOf>[0], _res: unknown, next: () => void) =>
        requestContext.run({ requestId: requestIdOf(req) }, next),
      )
      .forRoutes('*');
  }
}

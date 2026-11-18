import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccessAdminController } from './access/access.admin.controller';
import { AccessService } from './access/access.service';
import { AuthGuard } from './auth/auth.guard';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ConfigModule } from './config/config.module';
import { Db } from './database/db.service';
import { GcService } from './gc.service';
import { HealthController } from './health.controller';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { ClientRepository } from './sync/repositories/client.repository';
import { EntityRepository } from './sync/repositories/entity.repository';
import { RejectionRepository } from './sync/repositories/rejection.repository';
import { MutationExecutor } from './sync/push/mutation-executor';
import { ChangeLogRepository } from './sync/repositories/change-log.repository';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SyncController, AccessAdminController, HealthController],
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
    PullService,
    StreamService,
    GcService,
  ],
})
export class AppModule {}

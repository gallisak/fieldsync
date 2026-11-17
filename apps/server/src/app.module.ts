import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthGuard } from './auth';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ConfigModule } from './config/config.module';
import { Db } from './database/db.service';
import { GcService } from './gc.service';
import { HealthController } from './health.controller';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SyncController, HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    Db,
    AuthGuard,
    PushService,
    PullService,
    StreamService,
    GcService,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AuthGuard } from './auth';
import { ConfigModule } from './config/config.module';
import { Db } from './db';
import { GcService } from './gc.service';
import { HealthController } from './health.controller';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SyncController, HealthController],
  providers: [Db, AuthGuard, PushService, PullService, StreamService, GcService],
})
export class AppModule {}

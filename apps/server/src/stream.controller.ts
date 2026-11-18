import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AccessService } from './access/access.service';
import { AuthGuard, type AuthUser } from './auth/auth.guard';
import { CurrentUser } from './auth/current-user.decorator';
import { ProtocolGuard } from './common/protocol.guard';
import { Db } from './database/db.service';
import { StreamService } from './stream.service';

@Controller()
export class StreamController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly streams: StreamService,
  ) {}

  @Get('sync/stream')
  @UseGuards(ProtocolGuard, AuthGuard)
  async stream(@CurrentUser() user: AuthUser, @Res() res: Response) {
    this.streams.add(user.id, await this.access.accessibleSites(this.db.pool, user), res);
  }
}

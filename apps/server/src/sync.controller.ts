import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { pullQuerySchema, pushRequestSchema, type PullQuery, type PushRequest } from '@fieldsync/sync-core';
import type { Response } from 'express';
import { AccessService } from './access/access.service';
import { AuthGuard, type AuthUser } from './auth/auth.guard';
import { CurrentUser } from './auth/current-user.decorator';
import { ProtocolGuard } from './common/protocol.guard';
import { ZodPipe } from './common/zod.pipe';
import { Db } from './database/db.service';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';

@Controller()
export class SyncController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly pushService: PushService,
    private readonly pullService: PullService,
    private readonly streams: StreamService,
  ) {}

  @Get('me')
  @UseGuards(ProtocolGuard, AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const siteIds = [...(await this.access.accessibleSites(this.db.pool, user))];
    const { rows } = await this.db.pool.query(`SELECT id, name FROM sites WHERE id = ANY($1) ORDER BY name`, [siteIds]);
    return { id: user.id, role: user.role, sites: rows };
  }

  @Post('sync/push')
  @UseGuards(ProtocolGuard, AuthGuard)
  push(@CurrentUser() user: AuthUser, @Body(new ZodPipe(pushRequestSchema)) body: PushRequest) {
    return this.pushService.push(user, body);
  }

  @Get('sync/pull')
  @UseGuards(ProtocolGuard, AuthGuard)
  pull(@CurrentUser() user: AuthUser, @Query(new ZodPipe(pullQuerySchema)) query: PullQuery) {
    return this.pullService.pull(user, query);
  }

  @Get('sync/stream')
  @UseGuards(ProtocolGuard, AuthGuard)
  async stream(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const sites = [...(await this.access.accessibleSites(this.db.pool, user))];
    this.streams.add(sites, res);
  }
}

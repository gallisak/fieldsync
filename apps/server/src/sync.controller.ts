import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { pullQuerySchema, pushRequestSchema, type PullQuery, type PushRequest } from '@fieldsync/sync-core';
import type { Response } from 'express';
import { AccessService } from './access/access.service';
import { AuthGuard, type AuthedRequest } from './auth';
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
  async me(@Req() req: AuthedRequest) {
    const siteIds = [...(await this.access.accessibleSites(this.db.pool, req.user))];
    const { rows } = await this.db.pool.query(`SELECT id, name FROM sites WHERE id = ANY($1) ORDER BY name`, [siteIds]);
    return { id: req.user.id, role: req.user.role, sites: rows };
  }

  @Post('sync/push')
  @UseGuards(ProtocolGuard, AuthGuard)
  push(@Req() req: AuthedRequest, @Body(new ZodPipe(pushRequestSchema)) body: PushRequest) {
    return this.pushService.push(req.user, body);
  }

  @Get('sync/pull')
  @UseGuards(ProtocolGuard, AuthGuard)
  pull(@Req() req: AuthedRequest, @Query(new ZodPipe(pullQuerySchema)) query: PullQuery) {
    return this.pullService.pull(req.user, query);
  }

  @Get('sync/stream')
  @UseGuards(ProtocolGuard, AuthGuard)
  async stream(@Req() req: AuthedRequest, @Res() res: Response) {
    const sites = [...(await this.access.accessibleSites(this.db.pool, req.user))];
    this.streams.add(sites, res);
  }
}

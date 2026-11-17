import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { PushRequest } from '@fieldsync/sync-core';
import type { Response } from 'express';
import { accessibleSites } from './access';
import { AuthGuard, type AuthedRequest } from './auth';
import { Db } from './database/db.service';
import { PullService } from './pull.service';
import { PushService } from './push.service';
import { StreamService } from './stream.service';

function assertPushRequest(body: unknown): asserts body is PushRequest {
  const b = body as Partial<PushRequest> | null;
  const valid =
    b !== null &&
    typeof b === 'object' &&
    typeof b.clientId === 'string' &&
    b.clientId.length > 0 &&
    b.clientId.length <= 64 &&
    Array.isArray(b.mutations) &&
    b.mutations.length <= 100 &&
    b.mutations.every(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        Number.isInteger(m.id) &&
        m.id > 0 &&
        typeof m.name === 'string' &&
        m.args !== null &&
        typeof m.args === 'object',
    );
  if (!valid) throw new BadRequestException('Malformed push request');
}

@Controller()
@UseGuards(AuthGuard)
export class SyncController {
  constructor(
    private readonly db: Db,
    private readonly pushService: PushService,
    private readonly pullService: PullService,
    private readonly streams: StreamService,
  ) {}

  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const siteIds = await accessibleSites(this.db.pool, req.user);
    const { rows } = await this.db.pool.query(`SELECT id, name FROM sites WHERE id = ANY($1) ORDER BY name`, [siteIds]);
    return { id: req.user.id, role: req.user.role, sites: rows };
  }

  @Post('sync/push')
  push(@Req() req: AuthedRequest, @Body() body: unknown) {
    assertPushRequest(body);
    return this.pushService.push(req.user, body);
  }

  @Get('sync/pull')
  pull(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.pullService.pull(req.user, Number(cursor ?? 0) || 0, Number(limit ?? 500) || 500, clientId);
  }

  @Get('sync/stream')
  async stream(@Req() req: AuthedRequest, @Res() res: Response) {
    const sites = await accessibleSites(this.db.pool, req.user);
    this.streams.add(sites, res);
  }
}

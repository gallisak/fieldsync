import {
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  type PipeTransform,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard';
import { ProtocolGuard } from '../common/protocol.guard';
import { Db } from '../database/db.service';
import { StreamService } from '../stream.service';

export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest<AuthedRequest>().user.role !== 'admin') {
      throw new ForbiddenException('Only an admin can change access');
    }
    return true;
  }
}

// ParseUUIDPipe accepts upper case; Postgres and the open streams know the id in lower case.
const lowerCase: PipeTransform<string, string> = { transform: (v) => v.toLowerCase() };

@Controller('admin/users/:userId/sites/:siteId')
@UseGuards(ProtocolGuard, AuthGuard, AdminGuard)
export class AccessAdminController {
  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
  ) {}

  @Post()
  @HttpCode(204)
  async grant(
    @Param('userId', ParseUUIDPipe, lowerCase) userId: string,
    @Param('siteId', ParseUUIDPipe, lowerCase) siteId: string,
  ): Promise<void> {
    await this.db.tx(async (c) => {
      await requireUserAndSite(c, userId, siteId);
      await c.query(`INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        userId,
        siteId,
      ]);
    });
    await this.streams.refreshUser(userId);
  }

  @Delete()
  @HttpCode(204)
  async revoke(
    @Param('userId', ParseUUIDPipe, lowerCase) userId: string,
    @Param('siteId', ParseUUIDPipe, lowerCase) siteId: string,
  ): Promise<void> {
    await this.db.tx(async (c) => {
      await requireUserAndSite(c, userId, siteId);
      await c.query(`DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2`, [userId, siteId]);
    });
    await this.streams.refreshUser(userId);
  }
}

async function requireUserAndSite(c: PoolClient, userId: string, siteId: string): Promise<void> {
  const { rows } = await c.query<{ user: boolean; site: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1) AS user, EXISTS (SELECT 1 FROM sites WHERE id = $2) AS site`,
    [userId, siteId],
  );
  if (!rows[0].user || !rows[0].site) throw new NotFoundException('No such user or site');
}

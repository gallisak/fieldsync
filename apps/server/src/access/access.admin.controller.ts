import {
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthGuard, type AuthUser } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ProtocolGuard } from '../common/protocol.guard';
import { Db } from '../database/db.service';
import { StreamService } from '../stream.service';

@Controller('admin/users/:userId/sites/:siteId')
@UseGuards(ProtocolGuard, AuthGuard)
export class AccessAdminController {
  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
  ) {}

  @Post()
  @HttpCode(204)
  async grant(
    @CurrentUser() caller: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<void> {
    requireAdmin(caller);
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
    @CurrentUser() caller: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<void> {
    requireAdmin(caller);
    await this.db.tx(async (c) => {
      await requireUserAndSite(c, userId, siteId);
      await c.query(`DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2`, [userId, siteId]);
    });
    await this.streams.refreshUser(userId);
  }
}

function requireAdmin(user: AuthUser): void {
  if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change access');
}

async function requireUserAndSite(c: PoolClient, userId: string, siteId: string): Promise<void> {
  const { rows } = await c.query<{ user: boolean; site: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1) AS user, EXISTS (SELECT 1 FROM sites WHERE id = $2) AS site`,
    [userId, siteId],
  );
  if (!rows[0].user || !rows[0].site) throw new NotFoundException('No such user or site');
}

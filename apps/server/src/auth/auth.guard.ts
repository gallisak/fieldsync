import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Db } from '../database/db.service';
import { requestContext } from '../common/request-context';
import { tokenHash } from './token-hash';

export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

export type AuthedRequest = Request & { user: AuthUser };

/** Header only: a token in the URL ends up in access logs, proxy logs and browser history (F11). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException();
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE token_hash = $1`, [
      tokenHash(token),
    ]);
    if (rows.length === 0) throw new UnauthorizedException();
    req.user = rows[0];
    const context = requestContext.getStore();
    if (context) context.userId = req.user.id;
    return true;
  }
}

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Db } from './db';

export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

export type AuthedRequest = Request & { user: AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    let token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token && req.path === '/sync/stream' && typeof req.query.token === 'string') {
      token = req.query.token;
    }
    if (!token) throw new UnauthorizedException();
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE token = $1`, [token]);
    if (rows.length === 0) throw new UnauthorizedException();
    req.user = rows[0];
    return true;
  }
}

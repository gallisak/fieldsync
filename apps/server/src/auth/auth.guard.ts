import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Db } from '../database/db.service';
import { requestContext } from '../common/request-context';
import { tokenHash } from './token-hash';

export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

export type AuthedRequest = Request & { user: AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? (/^bearer +(\S+)$/i.exec(header)?.[1] ?? '') : '';
    const refuse = () => {
      http.getResponse<Response>().setHeader('www-authenticate', 'Bearer');
      return new UnauthorizedException();
    };
    if (!token) throw refuse();
    const { rows } = await this.db.pool.query<AuthUser>(`SELECT id, role FROM users WHERE token_hash = $1`, [
      tokenHash(token),
    ]);
    if (rows.length === 0) throw refuse();
    req.user = rows[0];
    const context = requestContext.getStore();
    if (context) {
      context.userId = req.user.id;
      // Push sends it in the body, pull in the query; the request's later lines, including the last, carry it.
      const clientId = (req.body as { clientId?: unknown } | undefined)?.clientId ?? req.query?.clientId;
      if (typeof clientId === 'string' && clientId.length <= 64) context.clientId = clientId;
    }
    return true;
  }
}

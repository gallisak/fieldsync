import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { MIN_PROTOCOL, PROTOCOL, PROTOCOL_HEADER } from '@fieldsync/sync-core';
import type { Request } from 'express';
import { ApiError } from './errors';

/** A missing header means a v1 client. */
@Injectable()
export class ProtocolGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const raw = ctx.switchToHttp().getRequest<Request>().headers[PROTOCOL_HEADER];
    const version = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 1;
    if (version < MIN_PROTOCOL || version > PROTOCOL) {
      throw new ApiError(
        'UPGRADE_REQUIRED',
        426,
        { min: MIN_PROTOCOL, current: PROTOCOL },
        'This app version is no longer supported; update it to keep syncing',
      );
    }
    return true;
  }
}

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { MIN_PROTOCOL, PROTOCOL, PROTOCOL_HEADER } from '@fieldsync/sync-core';
import type { Request } from 'express';
import { ApiError } from './errors';

@Injectable()
export class ProtocolGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const raw = ctx.switchToHttp().getRequest<Request>().headers[PROTOCOL_HEADER];
    const version = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 1;
    // The app was deployed before the server: it is not too old, so it should wait and retry, not ask to update.
    if (version > PROTOCOL) {
      throw new ApiError('UNAVAILABLE', 503, { current: PROTOCOL }, 'The server is being updated; retry later');
    }
    if (version < MIN_PROTOCOL) {
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

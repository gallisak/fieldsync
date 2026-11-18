import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthUser } from './auth.guard';

/** The user `AuthGuard` authenticated; only for routes behind that guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

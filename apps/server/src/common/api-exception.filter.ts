import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { isOperational } from '../database/db.service';
import { ApiError } from './errors';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
};

// body-parser rejects a body with an http-errors error, which is not an HttpException.
function clientErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; expose?: unknown } | null;
  return typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.expose === true ? e.status : undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.end();
      return;
    }

    if (err instanceof ApiError) {
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (status < 500) {
        res.status(status).json({ code: CODE_BY_STATUS[status] ?? `HTTP_${status}`, message: err.message });
        return;
      }
    }
    const status = clientErrorStatus(err);
    if (status !== undefined) {
      res.status(status).json({ code: CODE_BY_STATUS[status] ?? `HTTP_${status}`, message: (err as Error).message });
      return;
    }

    if (isOperational(err)) {
      this.logger.warn(`database unavailable: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({ code: 'UNAVAILABLE', message: 'Temporarily unavailable, retry later' });
      return;
    }

    this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    res.status(500).json({ code: 'INTERNAL', message: 'Unexpected server error' });
  }
}

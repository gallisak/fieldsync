import { PROTOCOL_HEADER } from '@fieldsync/sync-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from './config/env';

// The largest legal push: 100 mutations whose 5 200 characters of text are all control characters (6 bytes each in JSON).
export const JSON_BODY_LIMIT = '4mb';

export function configureHttp(app: NestExpressApplication, config: AppConfig): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.enableCors({
    origin: config.CORS_ORIGINS,
    allowedHeaders: ['authorization', 'content-type', PROTOCOL_HEADER, 'x-request-id'],
  });
}

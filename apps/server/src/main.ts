import 'reflect-metadata';
import { PROTOCOL_HEADER } from '@fieldsync/sync-core';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/env';

async function bootstrap() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableCors({
    origin: config.CORS_ORIGINS,
    allowedHeaders: ['authorization', 'content-type', PROTOCOL_HEADER, 'x-request-id'],
  });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  logger.log(`fieldsync server listening on ${config.PORT}`);
}
bootstrap();

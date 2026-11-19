import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/env';
import { configureHttp } from './http';

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  configureHttp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  logger.log(`fieldsync server listening on ${config.PORT}`);
}
bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'fieldsync server failed to start', err: String((err as Error)?.stack ?? err) }));
  process.exit(1);
});

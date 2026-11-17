import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`fieldsync server listening on ${port}`);
}
bootstrap();

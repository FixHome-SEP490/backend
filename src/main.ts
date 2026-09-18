import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApplication } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApplication(app);
  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `FixHome listening on port ${port}; Swagger /api/docs; health /health`,
  );
}
void bootstrap();

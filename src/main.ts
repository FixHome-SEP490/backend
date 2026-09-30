import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApplication } from './setup-app';
import { VN_TIME_ZONE } from './shared/utils/vn-time';

// Business logic computes Vietnam time explicitly; this only keeps anything
// left on local time (log timestamps, third-party code) in Vietnam time too,
// since container images default to UTC.
if (!process.env.TZ) process.env.TZ = VN_TIME_ZONE;

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

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApplication } from './setup-app';
import { VN_TIME_ZONE } from './shared/utils/vn-time';
import { installProcessSafety } from './process-safety';

/** The longest a single request may take to arrive in full. */
const UPLOAD_REQUEST_TIMEOUT_MS = 15 * 60_000;

// Business logic computes Vietnam time explicitly; this only keeps anything
// left on local time (log timestamps, third-party code) in Vietnam time too,
// since container images default to UTC.
if (!process.env.TZ) process.env.TZ = VN_TIME_ZONE;

installProcessSafety();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApplication(app);
  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
  // A 50 MB video on a weak mobile connection takes longer than Node's default
  // five minutes to arrive (PO 18/10/2026); headers still have to come within a minute.
  const server = app.getHttpServer();
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
  new Logger('Bootstrap').log(
    `FixHome listening on port ${port}; Swagger /api/docs; health /health`,
  );
}
void bootstrap();

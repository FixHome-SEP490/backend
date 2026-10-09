import { INestApplication, PayloadTooLargeException, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters';
import {
  TransformInterceptor,
  LoggingInterceptor,
} from './common/interceptors';
import { API_PREFIX, APP_NAME } from './shared/constants';
import { ApiErrorResponseDto } from './shared/dto';

/**
 * Room for the photographs the assistant looks at.
 *
 * Express defaults the JSON body to 100 KB, and the AI diagnosis route carries
 * up to three images inline as base64 - the encoding the AI Service accepts -
 * at up to 8 MiB each before encoding. Base64 adds about a third. So a full
 * request is around 33 MB and the default rejected every real photograph:
 * a 1.5 MB picture came back as a 500 and the app showed "chưa kết nối được
 * tới trợ lý", which points at the network and is nothing to do with it.
 */
const MAX_BODY_SIZE = '40mb';

/**
 * Every other JSON body is form data; files go up as multipart with their own
 * limits. Accepting 40 MB everywhere let any caller, signed in or not, make the
 * server parse 40 MB of JSON on any route.
 */
export const MAX_FORM_BODY_BYTES = 1024 * 1024;

/** The only routes that carry images inline. */
export const IMAGE_BODY_ROUTES = [`/${API_PREFIX}/ai/diagnoses`, `/${API_PREFIX}/ai-diagnosis/analyze`];

/**
 * Multipart uploads: one file of up to 10 MB each (multer enforces it per route), plus the form
 * fields. Until 10/10/2026 the 1 MB form limit applied to them too, so every photo over 1 MB, the
 * booking photos included, came back 413 and the app said "Không thể tải ảnh ... lên".
 */
export const MAX_MULTIPART_BODY_BYTES = 11 * 1024 * 1024;
export const FILE_UPLOAD_ROUTES: RegExp[] = [
  new RegExp(`^/${API_PREFIX}/media/(booking-photo-upload|upload)$`),
  new RegExp(`^/${API_PREFIX}/service-orders/[^/]+/evidence$`),
];

/**
 * Turns away a declared body over 1 MB before it is read, unless the route
 * carries images. One parser stays in place: a second, route-specific parser
 * would come from the top-level express 5 while Nest runs its own express 4,
 * and the two do not see each other's "already parsed" mark.
 */
export function formBodySizeGuard(req: Request, _res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length'] ?? 0);
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0].replace(/\/+$/, '');
  const multipart = String(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
  if (multipart && FILE_UPLOAD_ROUTES.some((route) => route.test(path))) {
    if (declared > MAX_MULTIPART_BODY_BYTES) next(new PayloadTooLargeException('Request payload is too large'));
    else next();
    return;
  }
  if (declared > MAX_FORM_BODY_BYTES && !IMAGE_BODY_ROUTES.includes(path)) {
    next(new PayloadTooLargeException('Request payload is too large'));
    return;
  }
  next();
}

export function normalizeOpenApiResponses(document: OpenAPIObject): void {
  for (const path of Object.values(document.paths ?? {})) {
    if (!path) continue;
    for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
      const operation = path[method];
      if (!operation) continue;
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if ('$ref' in response || status === '204') continue;
        const hasBinarySuccessContent = Number(status) < 400 &&
          Object.values(response.content ?? {}).some(mediaType => {
            const schema = mediaType.schema as { type?: string; format?: string } | undefined;
            return schema?.type === 'string' && schema.format === 'binary';
          });
        if (hasBinarySuccessContent) continue;

        const original = response.content?.['application/json']?.schema ?? {};
        response.content = {
          'application/json': {
            schema:
              Number(status) >= 400
                ? { $ref: '#/components/schemas/ApiErrorResponseDto' }
                : {
                    type: 'object',
                    required: ['success', 'statusCode', 'message', 'data'],
                    properties: {
                      success: { type: 'boolean', example: true },
                      statusCode: { type: 'integer', example: Number(status) },
                      message: { type: 'string', example: 'Success' },
                      data: original,
                      meta: {
                        type: 'object',
                        properties: {
                          page: { type: 'integer' },
                          limit: { type: 'integer' },
                          total: { type: 'integer' },
                          totalPages: { type: 'integer' },
                        },
                      },
                    },
                  },
          },
        };
      }
    }
  }
}

export function configureApplication(
  app: INestApplication & Partial<NestExpressApplication>,
): void {
  const configService = app.get(ConfigService);

  // MAX_BODY_SIZE đã được khai báo từ trước nhưng chưa bao giờ nối vào ứng dụng,
  // nên giới hạn thực tế vẫn là 100 KB mặc định của Express và đúng triệu chứng
  // mô tả ở phần khai báo vẫn còn nguyên. Nối vào đây cho giới hạn có hiệu lực.
  // `app` khai kiểu Partial<NestExpressApplication> vì test dựng app tối giản,
  // nên gọi có điều kiện.
  app.use(formBodySizeGuard);
  app.useBodyParser?.('json', { limit: MAX_BODY_SIZE });
  app.useBodyParser?.('urlencoded', { limit: MAX_BODY_SIZE, extended: true });

  // Security. Media (avatars, device photos, evidence, KYC previews) is served from
  // this API origin and embedded cross-origin by the web/mobile clients, so relax
  // Helmet's default same-origin Cross-Origin-Resource-Policy or every <img> pointed
  // at this backend silently fails to render (fetch() still "works" since CORP does
  // not gate fetch/XHR, only no-cors subresource loads like <img>/<script>).
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  const allowedOrigins = corsOrigin
    ? corsOrigin.split(',').map((origin) => origin.trim())
    : ['http://localhost:5173', 'http://localhost:8081'];

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global prefix (exclude health endpoints for direct platform/monitoring access)
  app.setGlobalPrefix(API_PREFIX, {
    exclude: ['health', 'health/(.*)', 'api/v1/health'],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // Swagger
  const config = new DocumentBuilder()
    .setTitle(`${APP_NAME} API`)
    .setDescription(`${APP_NAME} – Home Repair & Maintenance Platform API`)
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ApiErrorResponseDto],
  });
  // OpenAPI describes the same global envelope applied at runtime.
  normalizeOpenApiResponses(document);
  SwaggerModule.setup('api/docs', app, document);
}

// src/config/env.validation.ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsString,
  MinLength,
  Matches,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  // Database (PostgreSQL)
  @IsString()
  @IsOptional()
  DATABASE_HOST: string = 'localhost';

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  DATABASE_PORT: number = 5432;

  @IsString()
  @IsOptional()
  DATABASE_NAME: string = 'fixhome';

  @IsString()
  @IsOptional()
  DATABASE_USER: string = 'postgres';

  @IsString()
  @MinLength(1)
  DATABASE_PASSWORD: string;

  @IsOptional()
  DATABASE_SSL?: string | boolean;

  // JWT Authentication
  @IsString()
  @IsOptional()
  JWT_SECRET?: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRATION?: string = '1d';

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET?: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET?: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRES_IN: string = '7d';

  // AI Service
  @IsString()
  @IsOptional()
  AI_SERVICE_URL: string = 'http://localhost:8000';

  // Private Supabase Storage for KYC (credentials are server-only)
  @IsString()
  @IsOptional()
  SUPABASE_URL?: string;

  @IsString()
  @IsOptional()
  SUPABASE_SERVICE_ROLE_KEY?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/)
  SUPABASE_KYC_BUCKET: string = 'kyc-private';

  @IsInt()
  @Min(60)
  @Max(3600)
  @IsOptional()
  SUPABASE_KYC_SIGNED_URL_TTL_SECONDS: number = 300;

  @IsString()
  @IsOptional()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/)
  SUPABASE_BOOKING_PRIVATE_BUCKET?: string = 'booking-private';

  // Cloudinary (Optional)
  @IsString()
  @IsOptional()
  CLOUDINARY_CLOUD_NAME?: string;

  @IsString()
  @IsOptional()
  CLOUDINARY_API_KEY?: string;

  @IsString()
  @IsOptional()
  CLOUDINARY_API_SECRET?: string;

  // Google Maps (Optional, unused — superseded by MapTiler below)
  @IsString()
  @IsOptional()
  GOOGLE_MAPS_API_KEY?: string;

  // MapTiler (Optional — server-side REST key for Geocoding proxy)
  @IsString()
  @IsOptional()
  MAPTILER_API_KEY?: string;

  /**
   * Google Sign-In. Cả ba đều tuỳ chọn để backend vẫn khởi động được khi chưa
   * ai điền — lúc đó các endpoint /auth/google trả 503 kèm lời nhắc, thay vì
   * làm sập cả ứng dụng và chặn luôn những phần không liên quan.
   *
   * Một cặp dùng chung cho cả đội, không phải mỗi máy một cặp. CLIENT_ID là
   * công khai (nó nằm trong bundle web), CLIENT_SECRET chỉ backend giữ.
   */
  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Địa chỉ Google gọi ngược về sau khi người dùng đồng ý. Phải trùng từng ký
   * tự với ô Authorized redirect URIs trong Google Console.
   */
  @IsString()
  @IsOptional()
  GOOGLE_CALLBACK_URL: string =
    'http://localhost:3000/api/v1/auth/google/callback';

  /**
   * Các tiền tố mà backend được phép chuyển hướng về sau khi đăng nhập xong.
   * Mobile tự sinh địa chỉ của mình lúc chạy (Expo Go dùng exp://<IP-LAN>:8081)
   * nên không thể liệt kê cứng từng máy, nhưng cũng không được nhận bừa mọi địa
   * chỉ — nếu không kẻ tấn công sẽ lái token về máy của họ.
   */
  @IsString()
  @IsOptional()
  GOOGLE_ALLOWED_APP_REDIRECTS: string =
    'exp://,fixhome://,http://localhost:5173,http://localhost:8081';

  // CORS
  @IsString()
  @IsOptional()
  CORS_ORIGIN: string = 'http://localhost:5173,http://localhost:8081';

  // Mail (SMTP)
  @IsString()
  @IsOptional()
  MAIL_HOST?: string = 'smtp.gmail.com';

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  MAIL_PORT?: number = 587;

  @IsString()
  @IsOptional()
  MAIL_USERNAME?: string;

  @IsString()
  @IsOptional()
  MAIL_PASSWORD?: string;

  @IsString()
  @IsOptional()
  MAIL_FROM?: string;

  // VNPay (Optional — required only when payment.mode business config is LIVE)
  @IsString()
  @IsOptional()
  VNPAY_TMN_CODE?: string;

  @IsString()
  @IsOptional()
  VNPAY_HASH_SECRET?: string;

  @IsString()
  @IsOptional()
  VNPAY_PAYMENT_URL?: string;

  @IsString()
  @IsOptional()
  VNPAY_RETURN_URL?: string;

  @IsString()
  @IsOptional()
  FRONTEND_URL?: string;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const formattedErrors = errors
      .map((error) => {
        const constraints = Object.values(error.constraints || {}).join(', ');
        return `  - ${error.property}: ${constraints}`;
      })
      .join('\n');

    throw new Error(
      `[ConfigModule] Environment validation failed:\n${formattedErrors}\n` +
        `Please verify your .env file matches .env.example.`,
    );
  }

  const fail = (field: string): never => {
    throw new Error(`[ConfigModule] Invalid ${field}; check .env.example`);
  };
  if (
    validatedConfig.JWT_ACCESS_SECRET === validatedConfig.JWT_REFRESH_SECRET
  ) {
    fail('JWT secrets: access and refresh secrets must differ');
  }
  for (const key of [
    'JWT_ACCESS_EXPIRES_IN',
    'JWT_REFRESH_EXPIRES_IN',
  ] as const) {
    if (!/^[1-9]\d*(s|m|h|d)$/.test(validatedConfig[key])) fail(key);
  }
  if (
    config.DATABASE_SSL !== undefined &&
    !['true', 'false', true, false].includes(
      config.DATABASE_SSL as string | boolean,
    )
  ) {
    fail('DATABASE_SSL');
  }
  validatedConfig.DATABASE_SSL =
    config.DATABASE_SSL === true || config.DATABASE_SSL === 'true';
  if (validatedConfig.NODE_ENV === Environment.Production) {
    for (const key of [
      'DATABASE_HOST',
      'DATABASE_USER',
      'DATABASE_NAME',
      'CORS_ORIGIN',
    ] as const) {
      if (typeof config[key] !== 'string' || !(config[key] as string).trim())
        fail(key);
    }
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (
        /default|change.?in.?production|replace|example/i.test(
          validatedConfig[key],
        )
      )
        fail(key);
    }
  }
  for (const origin of validatedConfig.CORS_ORIGIN.split(',')) {
    try {
      const url = new URL(origin.trim());
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin.trim()
      )
        fail('CORS_ORIGIN');
    } catch {
      fail('CORS_ORIGIN');
    }
  }
  return validatedConfig;
}

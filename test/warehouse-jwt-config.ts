import { ConfigService } from '@nestjs/config';

/** Match Passport's effective ConfigService key, including the CI environment override. */
export function warehouseJwtConfig(fallbackSecret: string) {
  const config = new ConfigService({ JWT_ACCESS_SECRET: fallbackSecret });
  return { config, secret: config.getOrThrow<string>('JWT_ACCESS_SECRET') };
}

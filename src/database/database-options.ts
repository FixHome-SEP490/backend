import type { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/** Default size of the connection pool of one backend instance. */
export const DEFAULT_DATABASE_POOL_MAX = 5;

/**
 * Connection settings of the backend. The Supabase session pooler (port 5432)
 * gives the whole project 15 connections; without a limit each instance opened
 * pg's default 10 plus the live-updates listener, so the AWS backend and one
 * backend run locally against the shared database already went past 15 and
 * every request failed with EMAXCONNSESSION (23/10/2026). The pool is kept small
 * and idle connections are given back quickly.
 */
export function databaseOptions(config: ConfigService): TypeOrmModuleOptions {
  const poolMax = Number(config.get<string | number>('DATABASE_POOL_MAX', DEFAULT_DATABASE_POOL_MAX));
  return {
    type: 'postgres',
    host: config.get<string>('DATABASE_HOST', 'localhost'),
    port: config.get<number>('DATABASE_PORT', 5432),
    username: config.get<string>('DATABASE_USER', 'postgres'),
    password: config.getOrThrow<string>('DATABASE_PASSWORD'),
    database: config.get<string>('DATABASE_NAME', 'fixhome'),
    ssl: config.get<boolean>('DATABASE_SSL') === true ? { rejectUnauthorized: false } : false,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    // Use migrations in production, synchronize only in development
    synchronize: false,
    logging: false,
    // Migration config
    migrations: [__dirname + '/migrations/!(*.spec){.ts,.js}'],
    migrationsTableName: 'migrations',
    extra: {
      max: Number.isSafeInteger(poolMax) && poolMax > 0 ? poolMax : DEFAULT_DATABASE_POOL_MAX,
      // Give an idle connection back to the pooler after 10 s, and stop waiting for one after 15 s.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    },
  };
}

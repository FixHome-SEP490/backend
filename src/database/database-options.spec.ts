import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_POOL_MAX, databaseOptions } from './database-options';
import { installProcessSafety } from '../process-safety';
import { EventEmitter } from 'events';

// 23/10/2026: the shared database refused connections (EMAXCONNSESSION, 15 in session mode)
// and every unhandled rejection then stopped the server.
const config = (values: Record<string, unknown>) => ({
  get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
  getOrThrow: (key: string) => values[key] ?? 'secret',
}) as never;

describe('databaseOptions', () => {
  it('keeps one instance to a small pool and gives idle connections back', () => {
    const extra = (databaseOptions(config({})) as { extra: Record<string, number> }).extra;
    expect(extra).toEqual({ max: DEFAULT_DATABASE_POOL_MAX, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000 });
    expect(DEFAULT_DATABASE_POOL_MAX).toBeLessThanOrEqual(5);
  });

  it('reads the pool size from DATABASE_POOL_MAX and ignores a bad value', () => {
    expect((databaseOptions(config({ DATABASE_POOL_MAX: '3' })) as { extra: { max: number } }).extra.max).toBe(3);
    expect((databaseOptions(config({ DATABASE_POOL_MAX: 'abc' })) as { extra: { max: number } }).extra.max).toBe(DEFAULT_DATABASE_POOL_MAX);
    expect((databaseOptions(config({ DATABASE_POOL_MAX: 0 })) as { extra: { max: number } }).extra.max).toBe(DEFAULT_DATABASE_POOL_MAX);
  });
});

describe('installProcessSafety', () => {
  it('logs an unhandled rejection instead of letting it stop the server', () => {
    const target = new EventEmitter() as unknown as NodeJS.Process;
    const logged: string[] = [];
    installProcessSafety(target, { error: (message: string) => logged.push(message) } as never);
    target.emit('unhandledRejection', new Error('(EMAXCONNSESSION) max clients reached'), Promise.resolve());
    expect(logged[0]).toContain('EMAXCONNSESSION');
  });
});

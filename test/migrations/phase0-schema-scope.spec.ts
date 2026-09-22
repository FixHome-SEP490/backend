import { describe, expect, it, vi } from 'vitest';
import { Phase0Bootstrap1725891000000 } from '../../src/database/migrations/1725891000000-Phase0Bootstrap';
import type { QueryRunner } from 'typeorm';

describe('Phase0Bootstrap isolated-schema migration guard', () => {
  it('must check users columns only in current schema, not any public users table', async () => {
    const statements: string[] = [];
    const runner = { query: vi.fn(async (statement: string) => {
      statements.push(statement);
      return statement.includes('information_schema.columns') ? [] : undefined;
    }) };
    await new Phase0Bootstrap1725891000000().up(runner as unknown as QueryRunner);
    const checks = statements.filter(statement => statement.includes('information_schema.columns'));
    expect(checks).toHaveLength(2);
    for (const check of checks) expect(check).toMatch(/table_schema\s*=\s*current_schema\(\)/i);
    expect(statements.filter(statement => statement.includes('ALTER TABLE "users" ADD COLUMN'))).toHaveLength(2);
  });
});
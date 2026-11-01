import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { VisitGroupAddressSetNull1793293200004 } from '../../src/database/migrations/1793293200004-VisitGroupAddressSetNull';

const run = async (direction: 'up' | 'down') => {
  const queries: string[] = [];
  const runner = { query: vi.fn(async (sql: string) => { queries.push(sql.replace(/\s+/g, ' ').trim()); return []; }) };
  await new VisitGroupAddressSetNull1793293200004()[direction](runner as unknown as QueryRunner);
  return queries;
};

describe('DEF-r2-fix-visit-01 migration: a visit keeps no hard hold on the address', () => {
  it('makes visit_groups.address_id nullable with ON DELETE SET NULL, like bookings', async () => {
    const sql = await run('up');
    expect(sql[0]).toBe('ALTER TABLE "visit_groups" ALTER COLUMN "address_id" DROP NOT NULL');
    expect(sql[1]).toBe('ALTER TABLE "visit_groups" DROP CONSTRAINT IF EXISTS "visit_groups_address_id_fkey"');
    expect(sql[2]).toBe('ALTER TABLE "visit_groups" ADD CONSTRAINT "visit_groups_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL');
    expect(sql).toHaveLength(3);
  });

  it('restores the plain foreign key and only puts NOT NULL back when no visit lost its address', async () => {
    const sql = await run('down');
    expect(sql[1]).toBe('ALTER TABLE "visit_groups" ADD CONSTRAINT "visit_groups_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id")');
    expect(sql[1]).not.toContain('ON DELETE');
    expect(sql[2]).toContain('IF NOT EXISTS (SELECT 1 FROM "visit_groups" WHERE "address_id" IS NULL)');
    expect(sql[2]).toContain('SET NOT NULL');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SupportCases1725899000000 } from '../../src/database/migrations/1725899000000-SupportCases';

describe('SupportCases1725899000000', () => {
  it('creates bounded support enums/table/indexes/FKs without remote execution', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new SupportCases1725899000000().up(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('support_case_type_enum');
    expect(sql).toContain('support_case_status_enum');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "support_cases"');
    expect(sql).toContain('"evidence_refs" JSONB');
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('idx_support_cases_status_created_at');
    expect(sql).toContain('idx_support_cases_case_type_created_at');
    expect(sql).toContain('idx_support_cases_service_order_id');
    expect(sql).toContain('idx_support_cases_booking_id');
    expect(sql).toContain('idx_support_cases_assigned_manager_id');
  });

  it('rolls back without destructive CASCADE clauses', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new SupportCases1725899000000().down(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('DROP TABLE IF EXISTS "support_cases"');
    expect(sql).toContain('DROP TYPE IF EXISTS "support_case_status_enum"');
    expect(sql).not.toContain('CASCADE');
  });
});

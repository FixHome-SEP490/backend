import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { InterruptionWorkflow1793203200000 } from '../../src/database/migrations/1793203200000-InterruptionWorkflow';

describe('InterruptionWorkflow migration SQL structure (no PostgreSQL execution)', () => {
  it('adds durable command, active-request, outcome and rebook uniqueness guards', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => { statements.push(sql); return []; });
    await new InterruptionWorkflow1793203200000().up({ query } as unknown as QueryRunner);
    const sql = statements.join('\n');
    expect(sql).toContain('"workflow_version" integer NOT NULL DEFAULT 0');
    expect(sql).toContain('"interruption_command_id" uuid');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_support_active_stop_request"[\s\S]*"request_intent" = 'stop_or_replace'[\s\S]*"status" IN \('open', 'in_review'\)/);
    expect(sql).toContain('CREATE UNIQUE INDEX "uq_support_interruption_command"');
    expect(sql).toMatch(/"chk_visit_group_items_outcome" CHECK \([\s\S]*'interrupted'/);
    expect(sql).toContain('"source_case_id" uuid NOT NULL REFERENCES "support_cases"("id")');
    expect(sql).toContain('"target_booking_id" uuid NOT NULL REFERENCES "bookings"("id")');
    for (const index of ['uq_interruption_rebooks_scope_key', 'uq_interruption_rebook_source',
      'uq_interruption_rebook_case', 'uq_interruption_rebook_target']) {
      expect(sql).toContain(`CREATE UNIQUE INDEX "${index}"`);
    }
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it.each(['support_cases', 'visit_group_items', 'interruption_rebooks'])(
    'refuses rollback when %s holds workflow data', async table => {
      const statements: string[] = [];
      const query = vi.fn(async (sql: string) => {
        statements.push(sql);
        return sql.startsWith('SELECT count(*)') ? [{ count: sql.includes(`FROM "${table}"`) ? '1' : '0' }] : [];
      });
      await expect(new InterruptionWorkflow1793203200000().down({ query } as unknown as QueryRunner))
        .rejects.toThrow('Refusing to discard');
      expect(statements).not.toContain(expect.stringMatching(/^DROP TABLE/));
    },
  );
});

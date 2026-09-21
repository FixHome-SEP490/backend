import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { SimultaneousInvitationRoundIndex1727000000000 } from '../../src/database/migrations/1727000000000-SimultaneousInvitationRoundIndex';

const oldIndex = "CREATE UNIQUE INDEX uq_pending_invitation ON test_schema.booking_invitations USING btree (booking_id) WHERE (status = 'pending'::invitation_status_enum)";
const newIndex = "CREATE UNIQUE INDEX uq_pending_booking_technician ON test_schema.booking_invitations USING btree (booking_id, technician_id) WHERE (status = 'pending'::invitation_status_enum)";

describe('BE-MATCH PostgreSQL schema: simultaneous invitation round index', () => {
  it('replaces legacy booking-only pending index in the selected schema', async () => {
    const queries: string[] = [];
    const runner = { query: vi.fn(async (sql: string, params?: string[]) => {
      queries.push(sql);
      if (sql.includes('SELECT current_schema()')) return [{ target_schema: 'test_schema' }];
      if (sql.includes('FROM pg_indexes')) {
        expect(params).toEqual(['test_schema', 'uq_pending_invitation']);
        return [{ indexdef: oldIndex }];
      }
      return [];
    }) };
    await new SimultaneousInvitationRoundIndex1727000000000().up(runner as unknown as QueryRunner);
    const sql = queries.join('\n');
    expect(sql).toContain('DROP INDEX "test_schema"."uq_pending_invitation"');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_pending_booking_technician"\s+ON "test_schema"\."booking_invitations" \("booking_id", "technician_id"\) WHERE "status" = 'pending'/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*ON "test_schema"\."booking_invitations"\s*\("booking_id"\)\s*WHERE/i);
  });

  it('refuses to drop another schema index when legacy index is absent in target schema', async () => {
    const runner = { query: vi.fn(async (sql: string) => sql.includes('SELECT current_schema()')
      ? [{ target_schema: 'test_schema' }] : []) };
    await expect(new SimultaneousInvitationRoundIndex1727000000000().up(runner as unknown as QueryRunner))
      .rejects.toThrow(/current schema|unsafe migration/i);
    expect(runner.query).toHaveBeenCalledTimes(2);
  });

  it('refuses rollback when current-schema index is missing even when public contains one', async () => {
    const runner = { query: vi.fn(async (sql: string) => sql.includes('SELECT current_schema()')
      ? [{ target_schema: 'test_schema' }] : []) };
    await expect(new SimultaneousInvitationRoundIndex1727000000000().down(runner as unknown as QueryRunner))
      .rejects.toThrow(/current schema|unsafe migration/i);
    expect(runner.query).toHaveBeenCalledTimes(2);
  });

  it('refuses unsafe downgrade without dropping an index if multiple pending invitations exist', async () => {
    const queries: string[] = [];
    const runner = { query: vi.fn(async (sql: string, params?: string[]) => {
      queries.push(sql);
      if (sql.includes('SELECT current_schema()')) return [{ target_schema: 'test_schema' }];
      if (sql.includes('FROM pg_indexes')) {
        expect(params).toEqual(['test_schema', 'uq_pending_booking_technician']);
        return [{ indexdef: newIndex }];
      }
      if (sql.includes('HAVING COUNT(*) > 1')) return [{ booking_id: 'synthetic-booking' }];
      return [];
    }) };
    await expect(new SimultaneousInvitationRoundIndex1727000000000().down(runner as unknown as QueryRunner))
      .rejects.toThrow(/pending|downgrade/i);
    expect(queries.join('\n')).not.toMatch(/DROP INDEX|CREATE UNIQUE INDEX/);
  });

  it('restores legacy index only if pending round is compatible with downgrade', async () => {
    const queries: string[] = [];
    const runner = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT current_schema()')) return [{ target_schema: 'test_schema' }];
      if (sql.includes('FROM pg_indexes')) return [{ indexdef: newIndex }];
      return [];
    }) };
    await new SimultaneousInvitationRoundIndex1727000000000().down(runner as unknown as QueryRunner);
    const sql = queries.join('\n');
    expect(sql).toContain('DROP INDEX "test_schema"."uq_pending_booking_technician"');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_pending_invitation"\s+ON "test_schema"\."booking_invitations" \("booking_id"\) WHERE "status" = 'pending'/);
  });
});
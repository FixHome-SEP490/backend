import { describe, expect, it } from 'vitest';
import { type QueryRunner } from 'typeorm';
import { BookingDrafts1793379600002 } from './1793379600002-BookingDrafts';

describe('forward booking draft migration', () => {
  it('creates distinct active and immutable receipt tables with uniqueness, FKs, bounded JSON and RLS', async () => {
    const statements: string[] = [];
    await new BookingDrafts1793379600002().up({ query: async (sql: string) => { statements.push(sql.replace(/\s+/g, ' ').trim()); } } as QueryRunner);
    const sql = statements.join('\n');
    expect(sql).toContain('CREATE TABLE "booking_drafts"');
    expect(sql).toContain('UNIQUE ("customer_id")');
    expect(sql).toContain('CREATE TABLE "booking_draft_submit_receipts"');
    expect(sql).toContain('UNIQUE ("customer_id", "draft_id", "operation_key")');
    expect(sql).toContain('UNIQUE ("customer_id", "draft_id")');
    expect(sql).toContain('octet_length("snapshot"::text) <= 65536');
    expect(sql).toContain('"retain_until" >= "created_at" + interval \'30 days\'');
    expect(sql).not.toMatch(/REFERENCES "booking_drafts"|ALTER TABLE "bookings"|ALTER TABLE "visit_groups"/);
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "booking_draft_submit_receipts"');
    for (const table of ['booking_drafts', 'booking_draft_submit_receipts']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('refuses rollback with any saved draft or committed receipt', async () => {
    const statements: string[] = [];
    await expect(new BookingDrafts1793379600002().down({ query: async (sql: string) => {
      statements.push(sql); return sql.includes('SELECT EXISTS') ? [{ occupied: true }] : [];
    } } as QueryRunner)).rejects.toThrow('Refusing to delete saved booking drafts or submit receipts');
    expect(statements.join('\n')).not.toMatch(/DROP TABLE|DROP FUNCTION/);
  });
});

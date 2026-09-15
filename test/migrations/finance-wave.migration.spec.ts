import { describe, expect, it, vi } from 'vitest';
import { FinanceWaveFoundation1725900000000 } from '../../src/database/migrations/1725900000000-FinanceWaveFoundation';

describe('FinanceWaveFoundation1725900000', () => {
  it('creates durable payment idempotency, platform dues, and dispute attribution', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new FinanceWaveFoundation1725900000000().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('create table if not exists "payments"');
    expect(sql).toContain('unique ("idempotency_key")');
    expect(sql).toContain('uq_payments_provider_reference');
    expect(sql).toContain('create table if not exists "platform_dues"');
    expect(sql).toContain('uq_platform_due_order');
    expect(sql).toContain('alter table "cash_settlements"');
    expect(sql).toContain('disputed_by_customer_id');
    expect(sql).toContain('dispute_reason');
    expect(sql).toContain('on delete restrict');
  });

  it('drops only Finance Wave objects on down', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new FinanceWaveFoundation1725900000000().down(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('drop table if exists "platform_dues"');
    expect(sql).toContain('drop table if exists "payments"');
    expect(sql).not.toContain('drop table if exists "invoices"');
    expect(sql).not.toContain('cascade');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { VoucherFundingLedger1792994400001 } from '../../database/migrations/1792994400001-VoucherFundingLedger';

describe('voucher funding ledger migration contract', () => {
  it('allows one verified group wallet refund to be allocated across child invoices', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await new VoucherFundingLedger1792994400001().up({ query } as unknown as QueryRunner);
    const ddl = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(ddl).toMatch(/CREATE UNIQUE INDEX uq_voucher_entry_customer_wallet_transaction\s+ON public\.voucher_funding_entries\(customer_wallet_transaction_id,\s*invoice_id\)/);
    expect(ddl).not.toMatch(/ON public\.voucher_funding_entries\(customer_wallet_transaction_id\)\s+WHERE/);
  });

  it('requires complete per-invoice refund evidence before one terminal quota restoration', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    await new VoucherFundingLedger1792994400001().up({ query } as unknown as QueryRunner);
    const ddl = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(ddl).toContain("state IN ('RESERVED','RELEASED','EXPIRED','REDEEMED','REFUNDED')");
    expect(ddl).toContain('CREATE FUNCTION public.voucher_full_refund_verified');
    expect(ddl).toContain("kind = 'QUOTA_RESTORED'");
    expect(ddl).toContain('customer_due_vnd');
    expect(ddl).toContain('subsidy_vnd');
    expect(ddl).toContain('CREATE OR REPLACE FUNCTION public.voucher_guard_write');
    expect(ddl).toContain('REVOKE EXECUTE ON FUNCTION public.voucher_full_refund_verified(uuid) FROM PUBLIC');
    expect(ddl).toContain('REVOKE EXECUTE ON FUNCTION public.voucher_funding_append_only() FROM PUBLIC');
    expect(ddl).toContain('REVOKE EXECUTE ON FUNCTION public.voucher_guard_write() FROM PUBLIC');
    expect(ddl).toContain("ARRAY['anon','authenticated','service_role']");
    expect(ddl).toContain("t.type::text <> 'ADJUSTMENT'");
    expect(ddl).toContain("credit.kind = 'CASH_TECH_CREDIT'");
    expect(ddl).toContain('t.wallet_id <> paid_credit.wallet_id');
    expect(ddl).toContain("t.reference_type IS DISTINCT FROM 'VOUCHER_REFUND'");
    expect(ddl).toContain("t.reference_id IS DISTINCT FROM e.refund_source_id::text");
    expect(ddl).toContain("t.reference_type = 'SERVICE_ORDER' AND t.reference_id = i.service_order_id::text");
    expect(ddl).toContain("l.scope_kind = 'VISIT_GROUP' AND t.reference_type = 'VISIT_GROUP'");
    expect(ddl).toContain("kind NOT IN ('SUBSIDY_COMMITTED','CASH_TECH_CREDIT','CUSTOMER_REFUND','SUBSIDY_REVERSAL') OR amount_vnd > 0");
  });
});

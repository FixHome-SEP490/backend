import { describe, expect, it, vi } from 'vitest';
import { AddWalletTopUpToPaymentPurposeEnum1790000000010 } from '../../src/database/migrations/1790000000010-AddWalletTopUpToPaymentPurposeEnum';
import { PaymentTargetConstraintWalletTopUp1790000000011 } from '../../src/database/migrations/1790000000011-PaymentTargetConstraintWalletTopUp';

describe('Wallet Top-Up Migrations (1790000000010 & 1790000000011)', () => {
  it('adds wallet_top_up value to payment_purpose_enum', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new AddWalletTopUpToPaymentPurposeEnum1790000000010().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('alter type "payment_purpose_enum" add value if not exists \'wallet_top_up\'');
  });

  it('updates chk_payments_one_target to allow wallet_top_up with null targets', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new PaymentTargetConstraintWalletTopUp1790000000011().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('drop constraint if exists "chk_payments_one_target"');
    expect(sql).toContain('add constraint "chk_payments_one_target" check');
    expect(sql).toContain('wallet_top_up');
  });
});

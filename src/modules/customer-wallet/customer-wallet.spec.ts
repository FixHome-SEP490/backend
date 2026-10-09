import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CustomerWallet } from './entities/customer-wallet.entity';
import { CustomerWalletTransaction } from './entities/customer-wallet-transaction.entity';
import { CustomerWalletService } from './customer-wallet.service';

function harness(balance: number, existingKeys: string[] = []) {
  const wallet = { id: 'w1', userId: 'c1', balance };
  const saved: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const manager = {
    query: vi.fn(async () => []),
    findOne: vi.fn(async (entity: unknown, opts: { where: Record<string, unknown> }) => {
      if (entity === CustomerWalletTransaction) {
        return existingKeys.includes(opts.where.idempotencyKey as string) ? { id: 'old', idempotencyKey: opts.where.idempotencyKey } : null;
      }
      return null;
    }),
    findOneOrFail: vi.fn(async (entity: unknown) => (entity === CustomerWallet ? { ...wallet } : null)),
    update: vi.fn(async (_e: unknown, _id: unknown, values: Record<string, unknown>) => { updates.push(values); }),
    create: vi.fn((_e: unknown, v: Record<string, unknown>) => v),
    save: vi.fn(async (_e: unknown, v: Record<string, unknown>) => { saved.push(v); return v; }),
  };
  const service = new CustomerWalletService({} as never, {} as never, {} as never);
  return { service, manager, saved, updates };
}

describe('Customer wallet ledger (PO 08/10/2026)', () => {
  it('credits a top-up and records the balance before and after', async () => {
    const h = harness(50_000);
    const tx = await h.service.apply(h.manager as never, { userId: 'c1', type: 'top_up', amount: 100_000, idempotencyKey: 'TOP_UP:t1' });
    expect(h.updates).toEqual([{ balance: 150_000 }]);
    expect(tx).toMatchObject({ type: 'top_up', amount: 100_000, balanceBefore: 50_000, balanceAfter: 150_000, walletId: 'w1' });
  });

  it('credits a refund', async () => {
    const h = harness(0);
    const tx = await h.service.apply(h.manager as never, { userId: 'c1', type: 'refund', amount: 30_000, idempotencyKey: 'REFUND:CASE_1' });
    expect(tx.balanceAfter).toBe(30_000);
  });

  it('debits an invoice payment and refuses more than the balance', async () => {
    const h = harness(200_000);
    const tx = await h.service.apply(h.manager as never, { userId: 'c1', type: 'invoice_payment', amount: 200_000, idempotencyKey: 'INVOICE:i1' });
    expect(tx.balanceAfter).toBe(0);
    const poor = harness(199_999);
    await expect(poor.service.apply(poor.manager as never, { userId: 'c1', type: 'invoice_payment', amount: 200_000, idempotencyKey: 'INVOICE:i2' }))
      .rejects.toThrow('Số dư ví không đủ');
    expect(poor.updates).toHaveLength(0);
    expect(poor.saved).toHaveLength(0);
  });

  it('returns the first result on a retry with the same key and moves no money', async () => {
    const h = harness(100_000, ['INVOICE:i1']);
    const tx = await h.service.apply(h.manager as never, { userId: 'c1', type: 'invoice_payment', amount: 50_000, idempotencyKey: 'INVOICE:i1' });
    expect(tx).toMatchObject({ id: 'old' });
    expect(h.updates).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects amount %s', async (amount) => {
    const h = harness(100_000);
    await expect(h.service.apply(h.manager as never, { userId: 'c1', type: 'top_up', amount, idempotencyKey: 'k' })).rejects.toThrow('số nguyên dương');
  });

  it('credits and debits an admin correction, never below zero (PO 09/10/2026)', async () => {
    const h = harness(40_000);
    const up = await h.service.apply(h.manager as never, { userId: 'c1', type: 'adjustment_credit', amount: 10_000, idempotencyKey: 'CADJUST:1' });
    expect(up.balanceAfter).toBe(50_000);
    const low = harness(40_000);
    const down = await low.service.apply(low.manager as never, { userId: 'c1', type: 'adjustment_debit', amount: 15_000, idempotencyKey: 'CADJUST:2' });
    expect(down.balanceAfter).toBe(25_000);
    await expect(harness(40_000).service.apply(low.manager as never, { userId: 'c1', type: 'adjustment_debit', amount: 40_001, idempotencyKey: 'CADJUST:3' }))
      .rejects.toThrow('không đủ để trừ');
  });
});

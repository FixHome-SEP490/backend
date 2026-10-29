import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';
import { creditVoucherCustomerRefund } from './voucher-refund-wallet';

const source = {
  customerId: 'customer-1', serviceOrderId: 'order-1',
  refundSourceId: 'case-1', invoiceId: 'invoice-1', netVnd: 30,
};
const key = 'REFUND:case-1:invoice-1:CUSTOMER_REFUND';
const transaction = {
  id: 'transaction-1', walletId: 'wallet-1', type: 'refund', amount: 30,
  balanceBefore: 10, balanceAfter: 40, referenceType: 'SERVICE_ORDER',
  referenceId: 'order-1', idempotencyKey: key,
};

describe('voucher customer refund wallet entry', () => {
  it('uses the persisted NET amount and per-invoice key once in the caller transaction', async () => {
    const manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn().mockImplementation((entity: unknown) =>
        entity === CustomerWalletTransaction ? null :
        entity === CustomerWallet ? { id: 'wallet-1', userId: 'customer-1' } : null),
    } as unknown as EntityManager;
    const wallet = { apply: vi.fn().mockResolvedValue(transaction) } as unknown as CustomerWalletService;
    await expect(creditVoucherCustomerRefund(manager, wallet, source)).resolves.toMatchObject(transaction);
    expect(wallet.apply).toHaveBeenCalledExactlyOnceWith(manager, expect.objectContaining({
      userId: 'customer-1', type: 'refund', amount: 30, idempotencyKey: key,
      referenceType: 'SERVICE_ORDER', referenceId: 'order-1',
    }));
  });

  it('refuses an orphaned key or a mismatched wallet receipt', async () => {
    const manager = {
      queryRunner: { isTransactionActive: true },
      findOne: vi.fn().mockResolvedValueOnce(transaction),
    } as unknown as EntityManager;
    const wallet = { apply: vi.fn() } as unknown as CustomerWalletService;
    await expect(creditVoucherCustomerRefund(manager, wallet, source)).rejects.toThrow();
    expect(wallet.apply).not.toHaveBeenCalled();

    vi.mocked(manager.findOne).mockReset().mockImplementation((entity: unknown) =>
      entity === CustomerWalletTransaction ? Promise.resolve(null) :
      Promise.resolve({ id: 'wallet-1', userId: 'foreign-customer' }));
    vi.mocked(wallet.apply).mockResolvedValue(transaction as never);
    await expect(creditVoucherCustomerRefund(manager, wallet, source)).rejects.toThrow();
  });

  it('does not issue a zero-value wallet transaction', async () => {
    const manager = { queryRunner: { isTransactionActive: true }, findOne: vi.fn() } as unknown as EntityManager;
    const wallet = { apply: vi.fn() } as unknown as CustomerWalletService;
    await expect(creditVoucherCustomerRefund(manager, wallet, { ...source, netVnd: 0 })).rejects.toThrow();
    expect(wallet.apply).not.toHaveBeenCalled();
  });
});

import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { BusinessException } from '../../common/exceptions/business.exception';
import { WithdrawalStatus } from '../../shared/enums';
import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';
import { CustomerWithdrawalPayoutService } from './customer-withdrawal-payout.service';
import { MIN_WITHDRAWAL_AMOUNT } from './dto';
import { PayoutRejectedError, PayoutResult, PayoutUnknownError } from './payout/payout-provider';
import { PAYOUT_NOT_FOUND_GRACE_MS } from './withdrawal-payout.service';

/**
 * Customer withdrawals (PO 14/10/2026) keep the technician invariant: the
 * customer wallet is debited if and only if money is on its way to their bank.
 * The ledger is the real CustomerWalletService; only storage and payOS are
 * faked. Every case checks the balance and the ledger, not just the status.
 */

const CUSTOMER_ID = 'cust-1';
const ACCOUNT = {
  id: 'acc-1',
  customerId: CUSTOMER_ID,
  bankBin: '970436',
  bankCode: 'VCB',
  bankName: 'Vietcombank',
  accountNumber: '0123456789',
  accountName: 'NGUYEN VAN AN',
  updatedAt: new Date(),
};

const paid = (overrides: Partial<PayoutResult> = {}): PayoutResult => ({
  payoutId: 'po_1',
  outcome: 'SUCCEEDED',
  providerState: 'SUCCEEDED',
  bankReference: 'FT261014',
  failureReason: null,
  ...overrides,
});

describe('CustomerWithdrawalPayoutService', () => {
  let wallet: { id: string; userId: string; balance: number };
  let ledger: any[];
  let withdrawals: any[];
  let provider: any;
  let verifications: any;
  let bankAccounts: any;
  let notifications: any;
  let service: CustomerWithdrawalPayoutService;

  const only = () => {
    expect(withdrawals).toHaveLength(1);
    return withdrawals[0];
  };
  const ledgerOf = (type: string) => ledger.filter((tx) => tx.type === type);

  function build(balance: number) {
    wallet = { id: 'cw-1', userId: CUSTOMER_ID, balance };
    ledger = [];
    withdrawals = [];

    const statusesOf = (status: any): string[] => (Array.isArray(status?.value) ? status.value : [status]);
    const matches = (w: any, where: any) =>
      Object.entries(where ?? {}).every(([key, value]) =>
        key === 'status' ? statusesOf(value).includes(w.status) : w[key] === value,
      );
    const withdrawalRepo = {
      findOne: vi.fn(async ({ where }: any) => {
        const found = withdrawals.find((w) => matches(w, where));
        return found ? { ...found } : null;
      }),
      findOneByOrFail: vi.fn(async ({ id }: any) => {
        const found = withdrawals.find((w) => w.id === id);
        if (!found) throw new Error('not found');
        return { ...found };
      }),
      find: vi.fn(async ({ where }: any) => withdrawals.filter((w) => matches(w, where)).map((w) => ({ ...w }))),
      findAndCount: vi.fn(async ({ where }: any) => {
        const rows = withdrawals.filter((w) => matches(w, where));
        return [rows.map((w) => ({ ...w })), rows.length];
      }),
      create: vi.fn((dto: any) => ({ ...dto })),
      save: vi.fn(async (entity: any) => {
        const index = withdrawals.findIndex((w) => w.id === entity.id);
        if (index < 0) withdrawals.push({ ...entity, updatedAt: new Date() });
        else withdrawals[index] = { ...withdrawals[index], ...entity };
        return { ...entity };
      }),
      update: vi.fn(async (criteria: any, values: any) => {
        withdrawals.forEach((w, i) => {
          if (matches(w, criteria)) withdrawals[i] = { ...w, ...values };
        });
        return { affected: 1 };
      }),
    };
    const manager = {
      query: vi.fn(async () => []),
      findOne: vi.fn(async (entity: unknown, opts: any) => {
        if (entity === CustomerWalletTransaction) {
          return ledger.find((tx) => tx.idempotencyKey === opts.where.idempotencyKey) ?? null;
        }
        if (entity === CustomerWallet) return { ...wallet };
        return null;
      }),
      findOneOrFail: vi.fn(async () => ({ ...wallet })),
      update: vi.fn(async (entity: unknown, _id: unknown, values: any) => {
        if (entity === CustomerWallet) wallet.balance = values.balance;
      }),
      create: vi.fn((_entity: unknown, values: any) => ({ ...values })),
      save: vi.fn(async (_entity: unknown, values: any) => {
        const tx = { id: `tx-${ledger.length + 1}`, ...values };
        ledger.push(tx);
        return tx;
      }),
      getRepository: vi.fn(() => withdrawalRepo),
    };
    const dataSource = { transaction: vi.fn(async (fn: any) => fn(manager)) };
    const walletRepo = { findOne: vi.fn(async () => ({ ...wallet })) };
    const ledgerService = new CustomerWalletService(walletRepo as never, {} as never, dataSource as never);

    provider = {
      name: 'payos',
      createPayout: vi.fn(async () => paid()),
      findPayoutByReference: vi.fn(async () => null),
      getSourceBalance: vi.fn(async () => 100_000_000),
      estimateCredit: vi.fn(async (instruction: any) => instruction.amount),
    };
    verifications = {
      requireVerifiedName: vi.fn(async () => 'NGUYEN VAN AN'),
      statusOf: vi.fn(async () => ({ status: 'verified', rejectionReason: null })),
    };
    bankAccounts = { findMine: vi.fn(async () => ({ ...ACCOUNT })) };
    notifications = { createNotification: vi.fn(async () => ({})) };
    const audit = { logWithManager: vi.fn(async () => undefined) };
    const config = { get: vi.fn(() => 'test') };

    service = new CustomerWithdrawalPayoutService(
      withdrawalRepo as never,
      dataSource as never,
      ledgerService,
      verifications,
      bankAccounts,
      audit as never,
      config as never,
      provider,
      notifications,
    );
  }

  beforeEach(() => build(150_000));

  it('withdraws the whole balance: nothing is kept back, paid -> SUCCESS and balance 0', async () => {
    const result = await service.withdraw(CUSTOMER_ID, 150_000);
    expect(result.status).toBe(WithdrawalStatus.SUCCESS);
    expect(wallet.balance).toBe(0);
    expect(ledgerOf('withdrawal')).toHaveLength(1);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(0);
    expect(only()).toMatchObject({ status: 'SUCCESS', payoutBankReference: 'FT261014', bankAccountName: 'NGUYEN VAN AN' });
    // The payout reference is the id without dashes, so a lost answer can be looked up.
    expect(provider.createPayout.mock.calls[0][0]).toMatchObject({
      referenceId: only().id.replace(/-/g, ''),
      amount: 150_000,
      toBin: '970436',
      toAccountNumber: '0123456789',
    });
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CUSTOMER_ID, type: 'WALLET_WITHDRAWAL_PAID' }),
    );
  });

  it('refused by the provider -> FAILED and exactly one refund to the wallet', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutRejectedError('Số tài khoản không tồn tại'));
    const result = await service.withdraw(CUSTOMER_ID, 50_000);
    expect(result.status).toBe(WithdrawalStatus.FAILED);
    expect(result.failureReason).toBe('Số tài khoản không tồn tại');
    expect(wallet.balance).toBe(150_000);
    expect(ledgerOf('withdrawal')).toHaveLength(1);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(1);
    expect(only().refundTransactionId).toBe(ledgerOf('withdrawal_refund')[0].id);
    // Settling again (the reconciler racing the request) changes nothing.
    await service.reconcile(only().id);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(1);
    expect(wallet.balance).toBe(150_000);
  });

  it('a provider answer of FAILED also refunds once', async () => {
    provider.createPayout.mockResolvedValueOnce(paid({ outcome: 'FAILED', providerState: 'FAILED', failureReason: 'Ngân hàng từ chối' }));
    const result = await service.withdraw(CUSTOMER_ID, 20_000);
    expect(result).toMatchObject({ status: WithdrawalStatus.FAILED, failureReason: 'Ngân hàng từ chối' });
    expect(wallet.balance).toBe(150_000);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(1);
  });

  it('no clear answer -> stays PROCESSING with the money out, never refunded on a timeout', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutUnknownError('timeout'));
    const result = await service.withdraw(CUSTOMER_ID, 100_000);
    expect(result.status).toBe(WithdrawalStatus.PROCESSING);
    expect(result.payoutState).toBe('UNKNOWN');
    expect(wallet.balance).toBe(50_000);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(0);
  });

  it('the reconciler settles a PROCESSING withdrawal from what the provider says', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutUnknownError('timeout'));
    await service.withdraw(CUSTOMER_ID, 100_000);
    // Lookup fails: not an answer, stays PROCESSING.
    provider.findPayoutByReference.mockRejectedValueOnce(new Error('network'));
    expect((await service.reconcile(only().id)).status).toBe(WithdrawalStatus.PROCESSING);
    // Unknown to the provider but still inside the grace period: wait.
    provider.findPayoutByReference.mockResolvedValueOnce(null);
    expect((await service.reconcile(only().id)).status).toBe(WithdrawalStatus.PROCESSING);
    // The provider confirms it paid.
    provider.findPayoutByReference.mockResolvedValueOnce(paid({ bankReference: 'FT-LATE' }));
    expect(await service.reconcileProcessing()).toBe(1);
    expect(only()).toMatchObject({ status: 'SUCCESS', payoutBankReference: 'FT-LATE' });
    expect(wallet.balance).toBe(50_000);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(0);
  });

  it('the reconciler refunds once a payout the provider never received is past the grace period', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutUnknownError('timeout'));
    await service.withdraw(CUSTOMER_ID, 100_000);
    withdrawals[0].payoutAttemptedAt = new Date(Date.now() - PAYOUT_NOT_FOUND_GRACE_MS - 1000);
    await service.reconcileProcessing();
    await service.reconcileProcessing();
    expect(only().status).toBe('FAILED');
    expect(wallet.balance).toBe(150_000);
    expect(ledgerOf('withdrawal_refund')).toHaveLength(1);
  });

  it('refuses below the per-withdrawal minimum and non-integers, touching nothing', async () => {
    for (const amount of [MIN_WITHDRAWAL_AMOUNT - 1, 0, -10_000, 15_000.5, Number.NaN]) {
      await expect(service.withdraw(CUSTOMER_ID, amount)).rejects.toThrow(BusinessException);
    }
    await expect(service.withdraw(CUSTOMER_ID, 9_999)).rejects.toThrow('tối thiểu là 10.000');
    expect(ledger).toHaveLength(0);
    expect(withdrawals).toHaveLength(0);
    expect(provider.createPayout).not.toHaveBeenCalled();
  });

  it('refuses more than the balance, touching nothing', async () => {
    await expect(service.withdraw(CUSTOMER_ID, 150_001)).rejects.toThrow('toàn bộ số dư ví');
    expect(wallet.balance).toBe(150_000);
    expect(ledger).toHaveLength(0);
    expect(provider.createPayout).not.toHaveBeenCalled();
  });

  it('refuses a customer whose identity is not verified (none, pending or rejected)', async () => {
    for (const message of [
      'Bạn cần xác minh danh tính (CCCD) trước khi rút tiền.',
      'Hồ sơ xác minh danh tính của bạn đang chờ duyệt. Bạn có thể rút tiền sau khi hồ sơ được duyệt.',
    ]) {
      verifications.requireVerifiedName.mockRejectedValueOnce(new BusinessException('VALIDATION_FAILED', message));
      await expect(service.withdraw(CUSTOMER_ID, 50_000)).rejects.toThrow(message);
    }
    expect(verifications.requireVerifiedName).toHaveBeenCalledWith(CUSTOMER_ID, 'withdraw');
    expect(ledger).toHaveLength(0);
    expect(provider.createPayout).not.toHaveBeenCalled();
  });

  it('refuses without a saved bank account', async () => {
    bankAccounts.findMine.mockResolvedValueOnce(null);
    await expect(service.withdraw(CUSTOMER_ID, 50_000)).rejects.toThrow('tài khoản ngân hàng');
    expect(ledger).toHaveLength(0);
  });

  it('refuses before the wallet is touched when payouts are not configured or the source is short', async () => {
    provider.name = 'disabled';
    await expect(service.withdraw(CUSTOMER_ID, 50_000)).rejects.toThrow('chưa cấu hình cổng chi tiền');
    provider.name = 'payos';
    provider.getSourceBalance.mockResolvedValueOnce(1_000);
    await expect(service.withdraw(CUSTOMER_ID, 50_000)).rejects.toThrow('không bị trừ');
    expect(ledger).toHaveLength(0);
    expect(withdrawals).toHaveLength(0);
  });

  it('allows one withdrawal in flight at a time', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutUnknownError('timeout'));
    await service.withdraw(CUSTOMER_ID, 50_000);
    await expect(service.withdraw(CUSTOMER_ID, 50_000)).rejects.toThrow(ConflictException);
    expect(ledgerOf('withdrawal')).toHaveLength(1);
    expect(wallet.balance).toBe(100_000);
  });

  it('tells the wallet screen whether the customer can withdraw', async () => {
    expect(await service.info(CUSTOMER_ID)).toMatchObject({
      kycStatus: 'verified',
      hasBankAccount: true,
      minimumAmount: MIN_WITHDRAWAL_AMOUNT,
      maximumAmount: 150_000,
      payoutAvailable: true,
      openWithdrawal: null,
      canWithdraw: true,
    });
    verifications.statusOf.mockResolvedValueOnce({ status: 'pending', rejectionReason: null });
    expect(await service.info(CUSTOMER_ID)).toMatchObject({ kycStatus: 'pending', canWithdraw: false });
  });

  it('hides the provider raw error while a payout is still processing', async () => {
    provider.createPayout.mockRejectedValueOnce(new PayoutUnknownError('socket hang up'));
    await service.withdraw(CUSTOMER_ID, 50_000);
    const listed = await service.listMine(CUSTOMER_ID, { page: 1, limit: 20 });
    expect(listed.meta.total).toBe(1);
    expect(listed.data[0]).toMatchObject({ status: 'PROCESSING', failureReason: null, bankAccountNumber: '••••6789' });
  });
});

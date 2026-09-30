import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import {
  PAYOUT_NOT_FOUND_GRACE_MS,
  WithdrawalPayoutService,
} from './withdrawal-payout.service';
import {
  PayoutInstruction,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
  PayoutUnknownError,
} from './payout/payout-provider';
import { WalletTransactionType, WithdrawalStatus } from '../../shared/enums';
import { BusinessException } from '../../common/exceptions/business.exception';

/**
 * The invariant under test: the technician's wallet is debited if and only if
 * money is on its way to their bank. Every scenario ends by checking the wallet
 * balance and the ledger, not just the status field.
 *
 * There is no approval step (PO decision 30/09/2026): withdraw() checks,
 * debits and pays out in one call. WalletService is the real one, so the
 * debit and the refund go through the same mutateBalance code production uses.
 * Only storage and payOS are faked.
 */

const WALLET_ID = 'wallet-1';
const TECH_ID = 'tech-1';
const START_BALANCE = 850_000;
const MINIMUM_BALANCE = 200_000;

const ACCOUNT = {
  technicianId: TECH_ID,
  bankBin: '970422',
  bankCode: 'MB',
  bankName: 'MBBank',
  accountNumber: '0123456789012',
  accountName: 'PHAM DUC TOAN',
};

function success(overrides: Partial<PayoutResult> = {}): PayoutResult {
  return {
    payoutId: 'po_1',
    outcome: 'SUCCEEDED',
    providerState: 'SUCCEEDED',
    bankReference: 'FT26273123',
    failureReason: null,
    ...overrides,
  };
}

describe('WithdrawalPayoutService', () => {
  let wallet: { id: string; technicianId: string; balance: number };
  let ledger: any[];
  let withdrawals: any[];
  let bankAccount: typeof ACCOUNT | null;
  let provider: {
    name: 'mock';
    createPayout: ReturnType<typeof vi.fn>;
    findPayoutByReference: ReturnType<typeof vi.fn>;
    getSourceBalance: ReturnType<typeof vi.fn>;
    estimateCredit: ReturnType<typeof vi.fn>;
  };
  let audit: { logWithManager: ReturnType<typeof vi.fn> };
  let notifications: { createNotification: ReturnType<typeof vi.fn> };
  let service: WithdrawalPayoutService;

  const only = () => {
    expect(withdrawals).toHaveLength(1);
    return withdrawals[0];
  };
  const ledgerOf = (type: WalletTransactionType) =>
    ledger.filter((tx) => tx.type === type);

  beforeEach(() => {
    wallet = { id: WALLET_ID, technicianId: TECH_ID, balance: START_BALANCE };
    ledger = [];
    withdrawals = [];
    bankAccount = { ...ACCOUNT };

    const walletRepo = {
      findOne: vi.fn(async ({ where }) =>
        where?.id === wallet.id || where?.technicianId === wallet.technicianId
          ? { ...wallet }
          : null,
      ),
      findOneByOrFail: vi.fn(async ({ id }) => {
        if (id !== wallet.id) throw new Error('wallet not found');
        return { ...wallet };
      }),
      save: vi.fn(async (entity) => {
        wallet = { ...wallet, balance: Number(entity.balance) };
        return { ...wallet };
      }),
      create: vi.fn((dto) => dto),
    };
    const txRepo = {
      findOne: vi.fn(
        async ({ where }) =>
          ledger.find((tx) => tx.idempotencyKey === where?.idempotencyKey) ?? null,
      ),
      create: vi.fn((dto) => ({ id: `tx-${ledger.length + 1}`, ...dto })),
      save: vi.fn(async (tx) => {
        ledger.push(tx);
        return tx;
      }),
    };
    const statusesOf = (status: any): string[] =>
      Array.isArray(status?.value) ? status.value : [status];
    const withdrawalRepo = {
      findOne: vi.fn(async ({ where }) => {
        const found = where?.id
          ? withdrawals.find((w) => w.id === where.id)
          : withdrawals.find(
              (w) =>
                w.walletId === where?.walletId &&
                statusesOf(where?.status).includes(w.status),
            );
        return found ? { ...found } : null;
      }),
      findOneByOrFail: vi.fn(async ({ id }) => {
        const found = withdrawals.find((w) => w.id === id);
        if (!found) throw new Error('withdrawal not found');
        return { ...found };
      }),
      find: vi.fn(async ({ where }) =>
        withdrawals.filter((w) => w.status === where?.status).map((w) => ({ ...w })),
      ),
      create: vi.fn((dto) => ({ ...dto })),
      save: vi.fn(async (entity) => {
        const index = withdrawals.findIndex((w) => w.id === entity.id);
        if (index < 0) {
          withdrawals.push({ ...entity });
          return { ...entity };
        }
        withdrawals[index] = { ...withdrawals[index], ...entity };
        return { ...withdrawals[index] };
      }),
      update: vi.fn(async (criteria, changes) => {
        const target = withdrawals.find(
          (w) =>
            w.id === criteria.id &&
            (criteria.status === undefined || w.status === criteria.status),
        );
        if (target) Object.assign(target, changes);
        return { affected: target ? 1 : 0 };
      }),
      createQueryBuilder: vi.fn(() => {
        const builder: any = {
          select: () => builder,
          addSelect: () => builder,
          where: () => builder,
          groupBy: () => builder,
          getRawMany: async () => {
            const byStatus = new Map<string, { count: number; amount: number }>();
            for (const w of withdrawals) {
              const entry = byStatus.get(w.status) ?? { count: 0, amount: 0 };
              entry.count += 1;
              entry.amount += Number(w.amount);
              byStatus.set(w.status, entry);
            }
            return [...byStatus.entries()].map(([status, v]) => ({
              status,
              count: String(v.count),
              amount: String(v.amount),
            }));
          },
        };
        return builder;
      }),
    };
    const bankAccountRepo = {
      findOne: vi.fn(async ({ where }) =>
        bankAccount && where?.technicianId === bankAccount.technicianId
          ? { ...bankAccount }
          : null,
      ),
    };

    const manager = {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Wallet') return walletRepo;
        if (entity?.name === 'WalletTransaction') return txRepo;
        if (entity?.name === 'WithdrawalRequest') return withdrawalRepo;
        throw new Error(`unexpected repository ${entity?.name}`);
      },
    };
    // A failing transaction must leave nothing behind, as PostgreSQL would.
    const dataSource = {
      transaction: vi.fn(async (fn: (m: typeof manager) => unknown) => {
        const snapshot = {
          wallet: { ...wallet },
          ledger: [...ledger],
          withdrawals: withdrawals.map((w) => ({ ...w })),
        };
        try {
          return await fn(manager);
        } catch (error) {
          wallet = snapshot.wallet;
          ledger = snapshot.ledger;
          withdrawals = snapshot.withdrawals;
          throw error;
        }
      }),
    };

    audit = { logWithManager: vi.fn(async () => undefined) };
    notifications = { createNotification: vi.fn(async () => undefined) };

    const walletService = new WalletService(
      walletRepo as never,
      txRepo as never,
      withdrawalRepo as never,
      {} as never,
      dataSource as never,
      { getBigInt: vi.fn(async () => BigInt(MINIMUM_BALANCE)) } as never,
      audit as never,
      notifications as never,
    );

    provider = {
      name: 'mock',
      createPayout: vi.fn(async () => success()),
      findPayoutByReference: vi.fn(async () => null),
      getSourceBalance: vi.fn(async () => 10_000_000),
      estimateCredit: vi.fn(async (i: PayoutInstruction) => i.amount),
    };

    service = new WithdrawalPayoutService(
      withdrawalRepo as never,
      bankAccountRepo as never,
      dataSource as never,
      walletService,
      audit as never,
      { get: () => 'test' } as never,
      provider as unknown as PayoutProvider,
      notifications as never,
    );
  });

  describe('no approval step', () => {
    it('pays out in the same call the technician makes', async () => {
      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(provider.createPayout).toHaveBeenCalledTimes(1);
      expect(result.processedByUserId).toBeNull();
    });

    it('never creates a request left waiting for someone to approve it', async () => {
      await service.withdraw(TECH_ID, 300_000);

      expect(withdrawals.some((w) => w.status === WithdrawalStatus.PENDING)).toBe(false);
    });

    it('records the technician, not a manager, as who moved the money', async () => {
      await service.withdraw(TECH_ID, 300_000);

      const [, entry] = audit.logWithManager.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: TECH_ID,
        action: 'WITHDRAWAL_REQUESTED',
      });
      expect(JSON.stringify(entry)).not.toContain(ACCOUNT.accountNumber);
    });
  });

  describe('when payOS pays straight away', () => {
    it('debits once, marks SUCCESS and keeps the bank reference as proof', async () => {
      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.payoutBankReference).toBe('FT26273123');
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
      expect(ledgerOf(WalletTransactionType.WITHDRAW)).toHaveLength(1);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
    });

    it('pays the saved account, with a reference it can look up later', async () => {
      await service.withdraw(TECH_ID, 300_000);

      const [instruction, idempotencyKey] = provider.createPayout.mock.calls[0];
      const row = only();
      expect(instruction).toMatchObject({
        amount: 300_000,
        toBin: '970422',
        toAccountNumber: '0123456789012',
        referenceId: row.id.replace(/-/g, ''),
      });
      // Retrying the same withdrawal must reuse the key so payOS cannot pay twice.
      expect(idempotencyKey).toBe(row.id);
    });

    it('snapshots the account onto the withdrawal', async () => {
      await service.withdraw(TECH_ID, 300_000);

      expect(only()).toMatchObject({
        bankBin: '970422',
        bankName: 'MBBank',
        bankAccountNumber: '0123456789012',
        bankAccountName: 'PHAM DUC TOAN',
      });
    });

    it('debits before it asks payOS to pay', async () => {
      provider.createPayout.mockImplementation(async () => {
        // At the moment of the call the money must already be out of the wallet.
        expect(wallet.balance).toBe(START_BALANCE - 300_000);
        expect(only().status).toBe(WithdrawalStatus.PROCESSING);
        return success();
      });

      await service.withdraw(TECH_ID, 300_000);

      expect(provider.createPayout).toHaveBeenCalledTimes(1);
    });

    it('tells the technician once the money has left', async () => {
      await service.withdraw(TECH_ID, 300_000);

      expect(notifications.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: TECH_ID, type: 'WALLET_WITHDRAWAL_PAID' }),
      );
    });
  });

  describe('when payOS refuses the payout', () => {
    it('marks FAILED and returns exactly the debited amount to the wallet', async () => {
      provider.createPayout.mockRejectedValue(
        new PayoutRejectedError('Số tài khoản không tồn tại'),
      );

      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(result.failureReason).toBe('Số tài khoản không tồn tại');
      expect(wallet.balance).toBe(START_BALANCE);
      expect(ledgerOf(WalletTransactionType.WITHDRAW)).toHaveLength(1);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(1);
      expect(result.refundTransactionId).toBe(
        ledgerOf(WalletTransactionType.WITHDRAW_REFUND)[0].id,
      );
    });

    it('treats a FAILED answer from payOS the same way', async () => {
      provider.createPayout.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', failureReason: 'Tài khoản bị khoá', bankReference: null }),
      );

      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('frees the wallet for the next withdrawal', async () => {
      provider.createPayout.mockRejectedValueOnce(new PayoutRejectedError('x'));
      await service.withdraw(TECH_ID, 300_000);

      const second = await service.withdraw(TECH_ID, 100_000);

      expect(second.status).toBe(WithdrawalStatus.SUCCESS);
    });
  });

  describe('when nobody knows whether payOS acted', () => {
    beforeEach(() => {
      provider.createPayout.mockRejectedValue(new PayoutUnknownError('socket hang up'));
    });

    it('stays PROCESSING with the money held, and does not refund on a guess', async () => {
      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(result.payoutState).toBe('UNKNOWN');
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
    });

    it('settles to SUCCESS once payOS turns out to have paid', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);
      provider.findPayoutByReference.mockResolvedValue(success());

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('refunds once payOS turns out to have failed it', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', bankReference: null }),
      );

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('waits while payOS has no record and the grace period is running', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('refunds when payOS still has no record after the grace period', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);
      only().payoutAttemptedAt = new Date(Date.now() - PAYOUT_NOT_FOUND_GRACE_MS - 1000);

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(result.failureReason).toBe('Lệnh chi không tới được payOS');
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('does nothing when payOS cannot even be asked', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);
      only().payoutAttemptedAt = new Date(Date.now() - PAYOUT_NOT_FOUND_GRACE_MS - 1000);
      provider.findPayoutByReference.mockRejectedValue(new PayoutUnknownError('timeout'));

      const result = await service.reconcile(row.id);

      // Old enough to refund, but an unanswered question is not "not found".
      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('is picked up by the background pass and settled', async () => {
      await service.withdraw(TECH_ID, 300_000);
      provider.findPayoutByReference.mockResolvedValue(success());

      const visited = await service.reconcileProcessing();

      expect(visited).toBe(1);
      expect(only().status).toBe(WithdrawalStatus.SUCCESS);
    });
  });

  describe('settling twice', () => {
    it('refunds at most once even if a failure is reported again', async () => {
      provider.createPayout.mockRejectedValue(new PayoutRejectedError('x'));
      const row = await service.withdraw(TECH_ID, 300_000);
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', bankReference: null }),
      );

      await service.reconcile(row.id);

      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(1);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('does not refund when the reconciler already settled it as paid mid-call', async () => {
      // The background pass runs while the request is still waiting on payOS,
      // finds the payout paid and settles it; the request's own call then comes
      // back as a refusal. The refusal must lose: the money did leave.
      provider.findPayoutByReference.mockResolvedValue(success());
      provider.createPayout.mockImplementation(async () => {
        await service.reconcile(only().id);
        throw new PayoutRejectedError('duplicate request');
      });

      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('never flips a SUCCESS back to FAILED', async () => {
      const row = await service.withdraw(TECH_ID, 300_000);
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', bankReference: null }),
      );

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });
  });

  describe('refusing before any money moves', () => {
    const nothingMoved = () => {
      expect(wallet.balance).toBe(START_BALANCE);
      expect(ledger).toHaveLength(0);
      expect(withdrawals).toHaveLength(0);
      expect(provider.createPayout).not.toHaveBeenCalled();
    };

    it('refuses when the payout source cannot cover it', async () => {
      provider.getSourceBalance.mockResolvedValue(100_000);

      await expect(service.withdraw(TECH_ID, 300_000)).rejects.toThrow('thử lại sau');
      nothingMoved();
    });

    it('does not tell the technician how much the platform holds', async () => {
      provider.getSourceBalance.mockResolvedValue(123_456);

      const error = await service.withdraw(TECH_ID, 300_000).catch((e) => e);

      expect(error.message).not.toContain('123');
    });

    it('counts payOS fees when checking the source', async () => {
      provider.getSourceBalance.mockResolvedValue(300_000);
      provider.estimateCredit.mockResolvedValue(303_300);

      await expect(service.withdraw(TECH_ID, 300_000)).rejects.toThrow(BusinessException);
      nothingMoved();
    });

    it('goes ahead when the source balance cannot be read, since payOS will refuse if short', async () => {
      provider.getSourceBalance.mockResolvedValue(null);

      const result = await service.withdraw(TECH_ID, 300_000);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
    });

    it('keeps the minimum balance in the wallet', async () => {
      // 850k in the wallet, 200k must stay: 650k is the ceiling.
      await expect(service.withdraw(TECH_ID, 650_001)).rejects.toThrow('tối đa');
      nothingMoved();

      const result = await service.withdraw(TECH_ID, 650_000);
      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
    });

    it('holds the 10.000 ₫ minimum even when the DTO is bypassed', async () => {
      await expect(service.withdraw(TECH_ID, 9_999)).rejects.toThrow('tối thiểu');
      await expect(service.withdraw(TECH_ID, 10_000.5)).rejects.toThrow(BusinessException);
      nothingMoved();
    });

    it('refuses without a saved bank account', async () => {
      bankAccount = null;

      await expect(service.withdraw(TECH_ID, 300_000)).rejects.toThrow('tài khoản ngân hàng');
      nothingMoved();
    });

    it('refuses a second withdrawal while one is still moving to the bank', async () => {
      provider.createPayout.mockResolvedValue(
        success({ outcome: 'PROCESSING', providerState: 'PROCESSING', bankReference: null }),
      );
      await service.withdraw(TECH_ID, 100_000);

      await expect(service.withdraw(TECH_ID, 100_000)).rejects.toThrow(ConflictException);
      expect(withdrawals).toHaveLength(1);
      expect(ledgerOf(WalletTransactionType.WITHDRAW)).toHaveLength(1);
    });

    it('locks the wallet row before deciding', async () => {
      const lockSpy = vi.fn();
      const original = (service as any).dataSource.transaction;
      (service as any).dataSource.transaction = vi.fn(async (fn: any) =>
        original(async (manager: any) =>
          fn({
            getRepository: (entity: any) => {
              const repo = manager.getRepository(entity);
              if (entity?.name !== 'Wallet') return repo;
              return {
                ...repo,
                findOne: (args: any) => {
                  lockSpy(args);
                  return repo.findOne(args);
                },
              };
            },
          }),
        ),
      );

      await service.withdraw(TECH_ID, 300_000);

      expect(lockSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });
  });

  describe('overview', () => {
    it('totals what left, what is moving and what failed', async () => {
      await service.withdraw(TECH_ID, 100_000);
      provider.createPayout.mockRejectedValueOnce(new PayoutRejectedError('x'));
      await service.withdraw(TECH_ID, 50_000);

      const overview = await service.overview();

      expect(overview.provider).toBe('mock');
      expect(overview.sourceBalance).toBe(10_000_000);
      expect(overview.paidOut).toEqual({ count: 1, amount: 100_000 });
      expect(overview.failed).toEqual({ count: 1, amount: 50_000 });
      expect(overview.processing).toEqual({ count: 0, amount: 0 });
    });
  });
});

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
 * WalletService is the real one, so the debit and the refund go through the
 * same mutateBalance code production uses. Only storage and payOS are faked.
 */

const WALLET_ID = 'wallet-1';
const TECH_ID = 'tech-1';
const START_BALANCE = 850_000;
const MINIMUM_BALANCE = 200_000;

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

  const withdrawal = (id: string) => withdrawals.find((w) => w.id === id);
  const ledgerOf = (type: WalletTransactionType) =>
    ledger.filter((tx) => tx.type === type);

  function seedPending(overrides: Record<string, unknown> = {}) {
    const row = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      walletId: WALLET_ID,
      technicianId: TECH_ID,
      amount: 300_000,
      bankBin: '970436',
      bankName: 'Vietcombank',
      bankAccountNumber: '0123456789',
      bankAccountName: 'NGUYEN VAN THO',
      status: WithdrawalStatus.PENDING,
      requestedAt: new Date(),
      ...overrides,
    };
    withdrawals.push(row);
    return row;
  }

  beforeEach(() => {
    wallet = { id: WALLET_ID, technicianId: TECH_ID, balance: START_BALANCE };
    ledger = [];
    withdrawals = [];

    const walletRepo = {
      findOne: vi.fn(async ({ where }) =>
        where?.id === wallet.id || where?.technicianId === wallet.technicianId
          ? { ...wallet }
          : null,
      ),
      findOneBy: vi.fn(async ({ id }) => (id === wallet.id ? { ...wallet } : null)),
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
    const withdrawalRepo = {
      findOne: vi.fn(async ({ where }) => {
        const found = withdrawals.find((w) => w.id === where?.id);
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
      save: vi.fn(async (entity) => {
        const index = withdrawals.findIndex((w) => w.id === entity.id);
        withdrawals[index] = { ...withdrawals[index], ...entity };
        return { ...withdrawals[index] };
      }),
      update: vi.fn(async (criteria, changes) => {
        const target = withdrawals.find(
          (w) => w.id === criteria.id && w.status === criteria.status,
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

    const manager = {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Wallet') return walletRepo;
        if (entity?.name === 'WalletTransaction') return txRepo;
        if (entity?.name === 'WithdrawalRequest') return withdrawalRepo;
        throw new Error(`unexpected repository ${entity?.name}`);
      },
    };
    const dataSource = {
      transaction: vi.fn(async (fn: (m: typeof manager) => unknown) => fn(manager)),
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
      dataSource as never,
      walletService,
      audit as never,
      { get: () => 'test' } as never,
      provider as unknown as PayoutProvider,
      notifications as never,
    );
  });

  const SM = { id: 'sm-1', role: 'service_manager' };

  describe('when payOS pays straight away', () => {
    it('debits once, marks SUCCESS and keeps the bank reference as proof', async () => {
      const row = seedPending();

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(result.payoutBankReference).toBe('FT26273123');
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
      expect(ledgerOf(WalletTransactionType.WITHDRAW)).toHaveLength(1);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
    });

    it('sends the saved bank snapshot, and a reference it can look up later', async () => {
      const row = seedPending();

      await service.approve(row.id, SM);

      const [instruction, idempotencyKey] = provider.createPayout.mock.calls[0];
      expect(instruction).toMatchObject({
        amount: 300_000,
        toBin: '970436',
        toAccountNumber: '0123456789',
        referenceId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
      });
      // Retrying the same withdrawal must reuse the key so payOS cannot pay twice.
      expect(idempotencyKey).toBe(row.id);
    });

    it('debits before it asks payOS to pay', async () => {
      const row = seedPending();
      provider.createPayout.mockImplementation(async () => {
        // At the moment of the call the money must already be out of the wallet.
        expect(wallet.balance).toBe(START_BALANCE - 300_000);
        expect(withdrawal(row.id).status).toBe(WithdrawalStatus.PROCESSING);
        return success();
      });

      await service.approve(row.id, SM);

      expect(provider.createPayout).toHaveBeenCalledTimes(1);
    });

    it('tells the technician once the money has left', async () => {
      const row = seedPending();

      await service.approve(row.id, SM);

      expect(notifications.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: TECH_ID,
          type: 'WALLET_WITHDRAWAL_PAID',
        }),
      );
    });
  });

  describe('when payOS refuses the payout', () => {
    it('marks FAILED and returns exactly the debited amount to the wallet', async () => {
      const row = seedPending();
      provider.createPayout.mockRejectedValue(
        new PayoutRejectedError('Số tài khoản không tồn tại'),
      );

      const result = await service.approve(row.id, SM);

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
      const row = seedPending();
      provider.createPayout.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', failureReason: 'Tài khoản bị khoá', bankReference: null }),
      );

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(result.failureReason).toBe('Tài khoản bị khoá');
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('tells the technician the money is back', async () => {
      const row = seedPending();
      provider.createPayout.mockRejectedValue(new PayoutRejectedError('x'));

      await service.approve(row.id, SM);

      expect(notifications.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WALLET_WITHDRAWAL_FAILED' }),
      );
    });
  });

  describe('when nobody knows whether payOS acted', () => {
    beforeEach(() => {
      provider.createPayout.mockRejectedValue(
        new PayoutUnknownError('socket hang up'),
      );
    });

    it('stays PROCESSING with the money held, and does not refund on a guess', async () => {
      const row = seedPending();

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(result.payoutState).toBe('UNKNOWN');
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
    });

    it('settles to SUCCESS once payOS turns out to have paid, without refunding', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      provider.findPayoutByReference.mockResolvedValue(success());

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
    });

    it('refunds once payOS turns out to have failed it', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', failureReason: 'Ngân hàng từ chối', bankReference: null }),
      );

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('waits while payOS has no record yet and the grace period is running', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      provider.findPayoutByReference.mockResolvedValue(null);

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('refunds when payOS still has no record after the grace period', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      withdrawal(row.id).payoutAttemptedAt = new Date(
        Date.now() - PAYOUT_NOT_FOUND_GRACE_MS - 1000,
      );
      provider.findPayoutByReference.mockResolvedValue(null);

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(result.failureReason).toBe('Lệnh chi không tới được payOS');
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('does nothing when payOS cannot even be asked', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      withdrawal(row.id).payoutAttemptedAt = new Date(
        Date.now() - PAYOUT_NOT_FOUND_GRACE_MS - 1000,
      );
      provider.findPayoutByReference.mockRejectedValue(
        new PayoutUnknownError('timeout'),
      );

      const result = await service.reconcile(row.id);

      // Old enough to refund, but an unanswered question is not "not found".
      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });
  });

  describe('settling twice', () => {
    it('refunds at most once even if a failure is reported again', async () => {
      const row = seedPending();
      provider.createPayout.mockRejectedValue(new PayoutRejectedError('x'));
      await service.approve(row.id, SM);

      // The row is FAILED now; a late reconcile must leave it alone.
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', bankReference: null }),
      );
      await service.reconcile(row.id);

      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(1);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('does not refund when the reconciler already settled it as paid mid-call', async () => {
      const row = seedPending();
      // The background pass runs while approve is still waiting on payOS,
      // finds the payout paid and settles it; approve's own call then comes
      // back as a refusal. The refusal must lose: the money did leave.
      provider.findPayoutByReference.mockResolvedValue(success());
      provider.createPayout.mockImplementation(async () => {
        await service.reconcile(row.id);
        throw new PayoutRejectedError('duplicate request');
      });

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(ledgerOf(WalletTransactionType.WITHDRAW_REFUND)).toHaveLength(0);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('never flips a SUCCESS back to FAILED', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);
      provider.findPayoutByReference.mockResolvedValue(
        success({ outcome: 'FAILED', providerState: 'FAILED', bankReference: null }),
      );

      const result = await service.reconcile(row.id);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });
  });

  describe('refusing before any money moves', () => {
    it('refuses when the payout source cannot cover it, leaving everything as it was', async () => {
      const row = seedPending();
      provider.getSourceBalance.mockResolvedValue(100_000);

      await expect(service.approve(row.id, SM)).rejects.toThrow('Ví nguồn chi hộ không đủ số dư');

      expect(withdrawal(row.id).status).toBe(WithdrawalStatus.PENDING);
      expect(wallet.balance).toBe(START_BALANCE);
      expect(ledger).toHaveLength(0);
      expect(provider.createPayout).not.toHaveBeenCalled();
    });

    it('counts payOS fees when checking the source', async () => {
      const row = seedPending();
      provider.getSourceBalance.mockResolvedValue(300_000);
      provider.estimateCredit.mockResolvedValue(303_300);

      await expect(service.approve(row.id, SM)).rejects.toThrow(BusinessException);
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('goes ahead when the source balance cannot be read, since payOS will refuse if short', async () => {
      const row = seedPending();
      provider.getSourceBalance.mockResolvedValue(null);

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.SUCCESS);
    });

    it('re-checks the minimum balance at approval, not just at request time', async () => {
      const row = seedPending({ amount: 700_000 });

      await expect(service.approve(row.id, SM)).rejects.toThrow('thấp hơn mức tối thiểu');

      expect(wallet.balance).toBe(START_BALANCE);
      expect(withdrawal(row.id).status).toBe(WithdrawalStatus.PENDING);
      expect(provider.createPayout).not.toHaveBeenCalled();
    });

    it('refuses a request made before automatic payouts, which has no bank BIN', async () => {
      const row = seedPending({ bankBin: null });

      await expect(service.approve(row.id, SM)).rejects.toThrow('thiếu mã ngân hàng');
      expect(wallet.balance).toBe(START_BALANCE);
    });

    it('refuses to approve twice', async () => {
      const row = seedPending();
      await service.approve(row.id, SM);

      await expect(service.approve(row.id, SM)).rejects.toThrow(ConflictException);
      expect(ledgerOf(WalletTransactionType.WITHDRAW)).toHaveLength(1);
      expect(provider.createPayout).toHaveBeenCalledTimes(1);
    });
  });

  describe('a payout payOS accepts but has not finished', () => {
    it('stays PROCESSING and remembers the payOS id for the reconciler', async () => {
      const row = seedPending();
      provider.createPayout.mockResolvedValue(
        success({ outcome: 'PROCESSING', providerState: 'PROCESSING', bankReference: null }),
      );

      const result = await service.approve(row.id, SM);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(result.payoutId).toBe('po_1');
      expect(wallet.balance).toBe(START_BALANCE - 300_000);
    });

    it('is picked up by the background pass and settled', async () => {
      const row = seedPending();
      provider.createPayout.mockResolvedValue(
        success({ outcome: 'PROCESSING', providerState: 'PROCESSING', bankReference: null }),
      );
      await service.approve(row.id, SM);
      provider.findPayoutByReference.mockResolvedValue(success());

      const visited = await service.reconcileProcessing();

      expect(visited).toBe(1);
      expect(withdrawal(row.id).status).toBe(WithdrawalStatus.SUCCESS);
    });
  });

  describe('overview', () => {
    it('totals what left, what is moving and what is waiting', async () => {
      seedPending({ id: 'w-paid', status: WithdrawalStatus.SUCCESS, amount: 100_000 });
      seedPending({ id: 'w-moving', status: WithdrawalStatus.PROCESSING, amount: 50_000 });
      seedPending({ id: 'w-waiting', status: WithdrawalStatus.PENDING, amount: 20_000 });

      const overview = await service.overview();

      expect(overview.provider).toBe('mock');
      expect(overview.sourceBalance).toBe(10_000_000);
      expect(overview.paidOut).toEqual({ count: 1, amount: 100_000 });
      expect(overview.processing).toEqual({ count: 1, amount: 50_000 });
      expect(overview.pending).toEqual({ count: 1, amount: 20_000 });
      expect(overview.failed).toEqual({ count: 0, amount: 0 });
    });
  });
});

import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import {
  WalletTransactionType,
  WithdrawalStatus,
} from '../../shared/enums';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AdjustmentType } from './dto';

describe('WalletService', () => {
  let service: WalletService;
  let mockWalletRepo: any;
  let mockTxRepo: any;
  let mockWithdrawalRepo: any;
  let mockUserRepo: any;
  let mockDataSource: any;
  let mockConfigService: any;
  let mockAuditLogService: any;
  let mockNotificationsService: any;

  let storedWallet: any;
  let storedTransactions: any[];
  let storedWithdrawals: any[];

  beforeEach(() => {
    storedWallet = {
      id: 'wallet-uuid-1',
      technicianId: 'tech-uuid-1',
      balance: 850000,
    };
    storedTransactions = [];
    storedWithdrawals = [];

    mockWalletRepo = {
      findOne: vi.fn().mockImplementation(async ({ where }) => {
        if (where?.technicianId === storedWallet.technicianId || where?.id === storedWallet.id) {
          return { ...storedWallet };
        }
        return null;
      }),
      findOneByOrFail: vi.fn().mockImplementation(async ({ id }) => {
        if (id === storedWallet.id) return { ...storedWallet };
        throw new Error('Not found');
      }),
      create: vi.fn().mockImplementation((dto) => ({
        id: 'new-wallet-uuid',
        ...dto,
      })),
      save: vi.fn().mockImplementation(async (entity) => {
        storedWallet = { ...storedWallet, ...entity };
        return { ...storedWallet };
      }),
    };

    mockTxRepo = {
      findOne: vi.fn().mockImplementation(async ({ where }) => {
        return storedTransactions.find((tx) => tx.idempotencyKey === where?.idempotencyKey) || null;
      }),
      create: vi.fn().mockImplementation((dto) => ({
        id: `tx-${Date.now()}-${Math.random()}`,
        ...dto,
      })),
      save: vi.fn().mockImplementation(async (tx) => {
        storedTransactions.push(tx);
        return tx;
      }),
    };

    mockWithdrawalRepo = {
      findOne: vi.fn().mockImplementation(async ({ where }) => {
        if (where?.technicianId && where?.status) {
          return storedWithdrawals.find(
            (w) => w.technicianId === where.technicianId && w.status === where.status,
          ) || null;
        }
        if (where?.id) {
          return storedWithdrawals.find((w) => w.id === where.id) || null;
        }
        return null;
      }),
      createQueryBuilder: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getRawOne: vi.fn().mockResolvedValue({ total: '0' }),
      }),
      create: vi.fn().mockImplementation((dto) => ({
        id: `w-${Date.now()}`,
        ...dto,
      })),
      save: vi.fn().mockImplementation(async (w) => {
        const idx = storedWithdrawals.findIndex((x) => x.id === w.id);
        if (idx >= 0) {
          storedWithdrawals[idx] = { ...storedWithdrawals[idx], ...w };
          return storedWithdrawals[idx];
        }
        storedWithdrawals.push(w);
        return w;
      }),
    };

    mockConfigService = {
      getBigInt: vi.fn().mockResolvedValue(BigInt(200000)),
      getInt: vi.fn().mockResolvedValue(1000),
    };

    mockAuditLogService = {
      log: vi.fn().mockResolvedValue(undefined),
      logWithManager: vi.fn().mockResolvedValue(undefined),
      logWithManagerStrict: vi.fn().mockResolvedValue(undefined),
    };

    mockNotificationsService = {
      createNotification: vi.fn().mockResolvedValue(undefined),
    };

    mockDataSource = {
      transaction: vi.fn().mockImplementation(async (cb) => {
        const manager = {
          getRepository: (entityClass: any) => {
            if (entityClass?.name === 'Wallet') return mockWalletRepo;
            if (entityClass?.name === 'WalletTransaction') return mockTxRepo;
            if (entityClass?.name === 'WithdrawalRequest') return mockWithdrawalRepo;
            return mockWalletRepo;
          },
        };
        return cb(manager);
      }),
    };

    service = new WalletService(
      mockWalletRepo,
      mockTxRepo,
      mockWithdrawalRepo,
      mockUserRepo,
      mockDataSource,
      mockConfigService,
      mockAuditLogService,
      mockNotificationsService,
    );
  });

  describe('getWalletSummary', () => {
    it('correctly derives availableBalance, withdrawableBalance, and eligibleForJobs', async () => {
      const summary = await service.getWalletSummary('tech-uuid-1');

      expect(summary.balance).toBe(850000);
      expect(summary.pendingWithdrawal).toBe(0);
      expect(summary.minimumBalance).toBe(200000);
      expect(summary.availableBalance).toBe(850000);
      expect(summary.withdrawableBalance).toBe(650000); // 850k - 200k
      expect(summary.eligibleForJobs).toBe(true);
    });

    it('sets withdrawableBalance to 0 when balance is equal to minimumBalance', async () => {
      storedWallet.balance = 200000;
      const summary = await service.getWalletSummary('tech-uuid-1');

      expect(summary.withdrawableBalance).toBe(0);
      expect(summary.eligibleForJobs).toBe(true);
    });

    it('sets eligibleForJobs to false when balance is below minimumBalance', async () => {
      storedWallet.balance = 150000;
      const summary = await service.getWalletSummary('tech-uuid-1');

      expect(summary.withdrawableBalance).toBe(0);
      expect(summary.eligibleForJobs).toBe(false);
    });
  });

  describe('mutateBalance & Idempotency', () => {
    it('credits wallet on TOP_UP and records immutable transaction', async () => {
      const { wallet, transaction } = await service.mutateBalance({
        walletId: storedWallet.id,
        type: WalletTransactionType.TOP_UP,
        amount: 200000,
        idempotencyKey: 'TOP_UP_TEST_1',
      });

      expect(wallet.balance).toBe(1050000);
      expect(transaction.amount).toBe(200000);
      expect(transaction.balanceBefore).toBe(850000);
      expect(transaction.balanceAfter).toBe(1050000);
      expect(transaction.type).toBe(WalletTransactionType.TOP_UP);
    });

    it('is strictly idempotent on duplicate idempotencyKey', async () => {
      await service.mutateBalance({
        walletId: storedWallet.id,
        type: WalletTransactionType.TOP_UP,
        amount: 100000,
        idempotencyKey: 'IDEMP_KEY_1',
      });
      expect(storedWallet.balance).toBe(950000);

      // Replay with exact same idempotencyKey
      const replayed = await service.mutateBalance({
        walletId: storedWallet.id,
        type: WalletTransactionType.TOP_UP,
        amount: 100000,
        idempotencyKey: 'IDEMP_KEY_1',
      });

      expect(replayed.wallet.balance).toBe(950000); // Does NOT double credit!
      expect(storedTransactions).toHaveLength(1);
    });

    it('allows system charges (PLATFORM_FEE) to drive balance negative (Rule BR-WALLET-11)', async () => {
      storedWallet.balance = 50000;

      const { wallet, transaction } = await service.mutateBalance({
        walletId: storedWallet.id,
        type: WalletTransactionType.PLATFORM_FEE,
        amount: 150000,
        idempotencyKey: 'FEE_NEG_TEST',
        allowNegative: true,
      });

      expect(wallet.balance).toBe(-100000);
      expect(transaction.balanceAfter).toBe(-100000);
    });

    it('rejects withdrawal if balance is insufficient when allowNegative is false', async () => {
      storedWallet.balance = 50000;

      await expect(
        service.mutateBalance({
          walletId: storedWallet.id,
          type: WalletTransactionType.WITHDRAW,
          amount: 100000,
          idempotencyKey: 'WITHDRAW_FAIL',
          allowNegative: false,
        }),
      ).rejects.toThrow(BusinessException);
    });
  });

  describe('Withdrawal Flow & SM Approval', () => {
    it('creates a withdrawal request when requested amount is within withdrawableBalance', async () => {
      const request = await service.requestWithdrawal('tech-uuid-1', {
        amount: 300000,
        bankName: 'Vietcombank',
        bankAccountNumber: '999888777',
      });

      expect(request.amount).toBe(300000);
      expect(request.status).toBe(WithdrawalStatus.PENDING);
    });

    it('rejects withdrawal request if amount exceeds withdrawable balance', async () => {
      // Current balance = 850k, min = 200k -> max withdrawable = 650k
      await expect(
        service.requestWithdrawal('tech-uuid-1', {
          amount: 700000,
        }),
      ).rejects.toThrow(BusinessException);
    });

    it('rejects creating second withdrawal request when one is already PENDING', async () => {
      storedWithdrawals.push({
        id: 'existing-w',
        technicianId: 'tech-uuid-1',
        amount: 100000,
        status: WithdrawalStatus.PENDING,
      });

      await expect(
        service.requestWithdrawal('tech-uuid-1', {
          amount: 50000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('Service Manager approves withdrawal: deducts wallet and transitions to SUCCESS', async () => {
      storedWithdrawals.push({
        id: 'w-to-approve',
        walletId: storedWallet.id,
        technicianId: 'tech-uuid-1',
        amount: 300000,
        status: WithdrawalStatus.PENDING,
      });

      const approved = await service.approveWithdrawal('w-to-approve', {
        id: 'sm-uuid-1',
        role: 'service_manager',
      });

      expect(approved.status).toBe(WithdrawalStatus.SUCCESS);
      expect(storedWallet.balance).toBe(550000); // 850k - 300k
      expect(mockAuditLogService.logWithManager).toHaveBeenCalled();
      expect(mockNotificationsService.createNotification).toHaveBeenCalled();
    });

    it('Service Manager rejects withdrawal: requires reason and transitions to REJECTED without deducting balance', async () => {
      storedWithdrawals.push({
        id: 'w-to-reject',
        walletId: storedWallet.id,
        technicianId: 'tech-uuid-1',
        amount: 200000,
        status: WithdrawalStatus.PENDING,
      });

      const rejected = await service.rejectWithdrawal(
        'w-to-reject',
        'Sai so tai khoan ngan hang',
        { id: 'sm-uuid-1', role: 'service_manager' },
      );

      expect(rejected.status).toBe(WithdrawalStatus.REJECTED);
      expect(rejected.rejectReason).toBe('Sai so tai khoan ngan hang');
      expect(storedWallet.balance).toBe(850000); // Balance untouched
    });
  });

  describe('Admin Adjustment Flow', () => {
    it('adjusts balance with CREDIT and records strict audit log', async () => {
      const result = await service.adminAdjustBalance(
        'tech-uuid-1',
        {
          type: AdjustmentType.CREDIT,
          amount: 50000,
          reason: 'Hoan tien phi don hang loi',
        },
        { id: 'admin-uuid-1', role: 'admin' },
      );

      expect(result.wallet.balance).toBe(900000);
      expect(mockAuditLogService.logWithManagerStrict).toHaveBeenCalled();
      expect(mockNotificationsService.createNotification).toHaveBeenCalled();
    });

    it('fails when adjustment reason is missing', async () => {
      await expect(
        service.adminAdjustBalance(
          'tech-uuid-1',
          {
            type: AdjustmentType.CREDIT,
            amount: 50000,
            reason: '',
          },
          { id: 'admin-uuid-1', role: 'admin' },
        ),
      ).rejects.toThrow(BusinessException);
    });
  });
});

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { Role, WithdrawalStatus } from '../../shared/enums';
import { maskAccountNumber } from '../../shared/utils/bank-account-mask';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CustomerVerificationsService } from '../customer-verifications/customer-verifications.service';
import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerBankAccountService, toBankAccountResponse } from './customer-bank-account.service';
import {
  CustomerWithdrawalInfoDto,
  CustomerWithdrawalResponseDto,
  MAX_WITHDRAWAL_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
  QueryWithdrawalsDto,
} from './dto';
import { CustomerBankAccount, CustomerWithdrawalRequest } from './entities';
import { User } from '../users/entities/user.entity';
import { andWhereTextMatches } from '../../shared/utils/list-search';
import {
  PAYOUT_PROVIDER,
  PayoutInstruction,
  PayoutOutcome,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
} from './payout/payout-provider';
import { PAYOUT_NOT_FOUND_GRACE_MS, PayoutOverview } from './withdrawal-payout.service';

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_BATCH_SIZE = 20;
/** Same short, accent-free description the technician payouts use. */
const PAYOUT_DESCRIPTION = 'FixHome Cashout';

type Notice = { userId: string; title: string; message: string; type: string; referenceId: string };

/**
 * Customer withdrawals (PO 14/10/2026): the customer wallet paid out to the
 * customer's own bank account through the same payout provider as technician
 * withdrawals, with the same safety model as WithdrawalPayoutService:
 *
 *  1. The payout source is checked before the wallet is touched.
 *  2. The request is created PROCESSING and the customer wallet debited in one
 *     transaction, under the wallet row lock, before the provider is called.
 *  3. Provider paid -> SUCCESS. Provider refused -> FAILED and the amount
 *     returned to the wallet. No clear answer -> stays PROCESSING; the
 *     reconciler below asks the provider later. Never refunded on a timeout.
 *  4. Settling locks the row and only acts on PROCESSING, and the refund has
 *     its own idempotency key, so it happens at most once.
 *
 * Differences from technicians, all PO decisions: the whole balance may be
 * withdrawn (no minimum kept in the wallet), the per-withdrawal minimum is the
 * same MIN_WITHDRAWAL_AMOUNT, and an approved customer KYC is required.
 *
 * Kept apart from WithdrawalPayoutService so the technician flow and its
 * reconciler do not change; this service runs its own reconciler over the
 * customer table.
 */
@Injectable()
export class CustomerWithdrawalPayoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerWithdrawalPayoutService.name);
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    @InjectRepository(CustomerWithdrawalRequest)
    private readonly withdrawalRepo: Repository<CustomerWithdrawalRequest>,
    private readonly dataSource: DataSource,
    private readonly wallets: CustomerWalletService,
    private readonly verifications: CustomerVerificationsService,
    private readonly bankAccounts: CustomerBankAccountService,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    const interval = Number(
      this.config.get<string>('PAYOUT_RECONCILE_INTERVAL_MS') ?? DEFAULT_RECONCILE_INTERVAL_MS,
    );
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.timer = setInterval(() => {
      void this.reconcileProcessing();
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------- read

  /** What the wallet screen needs to offer (or explain) a withdrawal. */
  async info(customerId: string): Promise<CustomerWithdrawalInfoDto> {
    const [kyc, account, balance, open] = await Promise.all([
      this.verifications.statusOf(customerId),
      this.bankAccounts.findMine(customerId),
      this.wallets.balanceOf(customerId),
      this.withdrawalRepo.findOne({
        where: { customerId, status: In([WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING]) },
        order: { createdAt: 'DESC' },
      }),
    ]);
    const payoutAvailable = this.provider.name !== 'disabled';
    return {
      kycStatus: kyc.status,
      kycRejectionReason: kyc.rejectionReason,
      hasBankAccount: !!account,
      bankAccount: account ? toBankAccountResponse(account) : null,
      minimumAmount: MIN_WITHDRAWAL_AMOUNT,
      maximumAmount: Math.min(balance, MAX_WITHDRAWAL_AMOUNT),
      payoutAvailable,
      openWithdrawal: open ? toCustomerWithdrawalResponse(open) : null,
      canWithdraw:
        payoutAvailable && kyc.status === 'verified' && !!account && !open && balance >= MIN_WITHDRAWAL_AMOUNT,
    };
  }

  async listMine(
    customerId: string,
    query: QueryWithdrawalsDto,
  ): Promise<{ data: CustomerWithdrawalResponseDto[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [rows, total] = await this.withdrawalRepo.findAndCount({
      where: { customerId, ...(query.status ? { status: query.status } : {}) },
      order: { createdAt: 'DESC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      data: rows.map(toCustomerWithdrawalResponse),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ------------------------------------------------------------------ staff

  /**
   * What Service Managers and Admins see (PO 16/10/2026): customer withdrawals
   * only, from their own table, so they never mix with technicians'. Search
   * covers the customer's name (accents ignored), email and phone.
   */
  async listForStaff(query: QueryWithdrawalsDto & { search?: string }): Promise<{
    data: CustomerStaffWithdrawal[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const qb = this.withdrawalRepo.createQueryBuilder('w').innerJoin(User, 'u', 'u.id = w.customer_id');
    if (query.status) qb.andWhere('w.status = :status', { status: query.status });
    andWhereTextMatches(qb, ['u.full_name', 'u.email', 'u.phone_number'], query.search);
    const [rows, total] = await qb
      .orderBy('w.requestedAt', 'DESC')
      .addOrderBy('w.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const ids = [...new Set(rows.map((w) => w.customerId))];
    const users = ids.length
      ? await this.dataSource.getRepository(User).find({
          where: { id: In(ids) },
          select: { id: true, fullName: true, email: true, phoneNumber: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      data: rows.map((w) => toStaffCustomerWithdrawalResponse(w, byId.get(w.customerId))),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Customer totals by outcome, and the payout channel's balance (shared with technicians). */
  async overview(): Promise<PayoutOverview> {
    const rows = await this.withdrawalRepo
      .createQueryBuilder('w')
      .select('w.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(w.amount), 0)', 'amount')
      .groupBy('w.status')
      .getRawMany<{ status: WithdrawalStatus; count: string; amount: string }>();
    const bucket = (status: WithdrawalStatus) => {
      const row = rows.find((r) => r.status === status);
      return { count: Number(row?.count ?? 0), amount: Number(row?.amount ?? 0) };
    };
    return {
      provider: this.provider.name,
      sourceBalance: await this.provider.getSourceBalance(),
      paidOut: bucket(WithdrawalStatus.SUCCESS),
      processing: bucket(WithdrawalStatus.PROCESSING),
      pending: bucket(WithdrawalStatus.PENDING),
      failed: bucket(WithdrawalStatus.FAILED),
    };
  }

  /** One withdrawal for staff after a reconcile, with the customer's contact. */
  async staffView(withdrawal: CustomerWithdrawalRequest): Promise<CustomerStaffWithdrawal> {
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: withdrawal.customerId },
      select: { id: true, fullName: true, email: true, phoneNumber: true },
    });
    return toStaffCustomerWithdrawalResponse(withdrawal, user ?? undefined);
  }

  // ----------------------------------------------------------------- withdraw

  async withdraw(customerId: string, amount: number): Promise<CustomerWithdrawalRequest> {
    if (this.provider.name === 'disabled') {
      throw new BusinessException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Rút tiền chưa mở vì hệ thống chưa cấu hình cổng chi tiền. Vui lòng liên hệ FixHome.',
      );
    }
    if (!Number.isSafeInteger(amount) || amount < MIN_WITHDRAWAL_AMOUNT) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Số tiền rút tối thiểu là ${MIN_WITHDRAWAL_AMOUNT.toLocaleString('vi-VN')} ₫`,
      );
    }
    if (amount > MAX_WITHDRAWAL_AMOUNT) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Mỗi lần rút tối đa ${MAX_WITHDRAWAL_AMOUNT.toLocaleString('vi-VN')} ₫`,
      );
    }

    await this.verifications.requireVerifiedName(customerId, 'withdraw');
    const bankAccount = await this.bankAccounts.findMine(customerId);
    if (!bankAccount) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Bạn cần khai báo tài khoản ngân hàng nhận tiền trước khi rút tiền',
      );
    }
    // Checked again under the lock; this only spares a provider call.
    this.assertWithinBalance(amount, await this.wallets.balanceOf(customerId));

    const withdrawalId = randomUUID();
    const instruction: PayoutInstruction = {
      referenceId: referenceIdFor(withdrawalId),
      amount,
      description: PAYOUT_DESCRIPTION,
      toBin: bankAccount.bankBin,
      toAccountNumber: bankAccount.accountNumber,
    };

    await this.assertSourceCanPay(instruction);
    await this.openAndDebit(withdrawalId, customerId, amount, bankAccount);
    return this.sendPayout(withdrawalId, instruction);
  }

  private assertWithinBalance(amount: number, balance: number): void {
    if (amount > balance) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Số tiền rút tối đa hiện tại là ${balance.toLocaleString('vi-VN')} ₫ (toàn bộ số dư ví)`,
      );
    }
  }

  private async sendPayout(
    withdrawalId: string,
    instruction: PayoutInstruction,
  ): Promise<CustomerWithdrawalRequest> {
    try {
      const result = await this.provider.createPayout(instruction, withdrawalId);
      return await this.settle(withdrawalId, result.outcome, result);
    } catch (error) {
      if (error instanceof PayoutRejectedError) {
        return this.settle(withdrawalId, 'FAILED', null, error.message);
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Payout for customer withdrawal ${withdrawalId} has no confirmed outcome yet: ${reason}`,
      );
      return this.recordUnknown(withdrawalId, reason);
    }
  }

  private async assertSourceCanPay(instruction: PayoutInstruction): Promise<void> {
    const [needed, available] = await Promise.all([
      this.provider.estimateCredit(instruction),
      this.provider.getSourceBalance(),
    ]);
    if (available !== null && available < needed) {
      this.logger.warn(
        `Payout source short: has ${available}, needs ${needed}. Top up the payOS wallet.`,
      );
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Hệ thống chi hộ tạm thời chưa đủ tiền để chi lệnh này. Số dư ví của bạn không bị trừ, vui lòng thử lại sau.',
      );
    }
  }

  private async openAndDebit(
    withdrawalId: string,
    customerId: string,
    amount: number,
    bankAccount: CustomerBankAccount,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { id: walletId } = await this.wallets.getOrCreate(manager, customerId);
      const locked = await manager.findOne(CustomerWallet, {
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Ví không tồn tại');

      const withdrawalRepo = manager.getRepository(CustomerWithdrawalRequest);
      const open = await withdrawalRepo.findOne({
        where: {
          walletId: locked.id,
          status: In([WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING]),
        },
      });
      if (open) {
        throw new ConflictException(
          'Bạn đang có một lệnh rút đang được chuyển về ngân hàng. Vui lòng đợi hoàn tất trước khi rút tiếp.',
        );
      }
      // The whole balance may go (PO 14/10/2026): nothing is kept back.
      this.assertWithinBalance(amount, Number(locked.balance));

      const now = new Date();
      await withdrawalRepo.save(
        withdrawalRepo.create({
          id: withdrawalId,
          walletId: locked.id,
          customerId,
          amount,
          bankBin: bankAccount.bankBin,
          bankName: bankAccount.bankName,
          bankAccountNumber: bankAccount.accountNumber,
          bankAccountName: bankAccount.accountName,
          status: WithdrawalStatus.PROCESSING,
          requestedAt: now,
          payoutAttemptedAt: now,
        }),
      );

      const debit = await this.wallets.apply(manager, {
        userId: customerId,
        type: 'withdrawal',
        amount,
        idempotencyKey: `CWITHDRAW:${withdrawalId}`,
        referenceType: 'CUSTOMER_WITHDRAWAL',
        referenceId: withdrawalId,
        description: `Rút tiền về ${bankAccount.bankName} - STK ${maskAccountNumber(bankAccount.accountNumber)}`,
      });
      await withdrawalRepo.update({ id: withdrawalId }, { transactionId: debit.id });

      await this.auditLogService.logWithManager(manager, {
        actorUserId: customerId,
        actorRole: Role.CUSTOMER,
        action: 'CUSTOMER_WITHDRAWAL_REQUESTED',
        resourceType: 'customer_withdrawal_request',
        resourceId: withdrawalId,
        after: {
          amount,
          balanceAfter: Number(debit.balanceAfter),
          bankCode: bankAccount.bankCode,
          accountNumberTail: bankAccount.accountNumber.slice(-4),
          payoutProvider: this.provider.name,
        },
      });
    });
  }

  // -------------------------------------------------------------- settlement

  private async settle(
    withdrawalId: string,
    outcome: PayoutOutcome,
    result: PayoutResult | null,
    rejection?: string,
  ): Promise<CustomerWithdrawalRequest> {
    let notice: Notice | null = null;

    const settled = await this.dataSource.transaction(async (manager) => {
      const withdrawalRepo = manager.getRepository(CustomerWithdrawalRequest);
      const withdrawal = await withdrawalRepo.findOne({
        where: { id: withdrawalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
      if (withdrawal.status !== WithdrawalStatus.PROCESSING) return withdrawal;

      if (result) {
        withdrawal.payoutId = result.payoutId ?? withdrawal.payoutId ?? null;
        withdrawal.payoutState = result.providerState;
        withdrawal.payoutBankReference = result.bankReference ?? withdrawal.payoutBankReference ?? null;
      }
      const amount = Number(withdrawal.amount);

      if (outcome === 'SUCCEEDED') {
        withdrawal.status = WithdrawalStatus.SUCCESS;
        withdrawal.failureReason = null;
        await withdrawalRepo.save(withdrawal);
        await this.auditLogService.logWithManager(manager, {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'CUSTOMER_WITHDRAWAL_PAID_OUT',
          resourceType: 'customer_withdrawal_request',
          resourceId: withdrawal.id,
          after: { amount, payoutId: withdrawal.payoutId, bankReference: withdrawal.payoutBankReference },
        });
        notice = {
          userId: withdrawal.customerId,
          title: 'Đã chuyển tiền về tài khoản ngân hàng',
          message: `${amount.toLocaleString('vi-VN')} ₫ đã được chuyển về ${withdrawal.bankName} - STK ${maskAccountNumber(withdrawal.bankAccountNumber) ?? ''}.`,
          type: 'WALLET_WITHDRAWAL_PAID',
          referenceId: withdrawal.id,
        };
        return withdrawal;
      }

      if (outcome === 'FAILED') {
        const reason = rejection ?? result?.failureReason ?? 'Ngân hàng không nhận lệnh chuyển tiền';
        const refund = await this.wallets.apply(manager, {
          userId: withdrawal.customerId,
          type: 'withdrawal_refund',
          amount,
          idempotencyKey: `CWITHDRAW_REFUND:${withdrawal.id}`,
          referenceType: 'CUSTOMER_WITHDRAWAL',
          referenceId: withdrawal.id,
          description: `Hoàn tiền rút không thành công - ${reason}`.slice(0, 255),
        });
        withdrawal.status = WithdrawalStatus.FAILED;
        withdrawal.failureReason = reason;
        withdrawal.refundTransactionId = refund.id;
        await withdrawalRepo.save(withdrawal);
        await this.auditLogService.logWithManager(manager, {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'CUSTOMER_WITHDRAWAL_PAYOUT_FAILED',
          resourceType: 'customer_withdrawal_request',
          resourceId: withdrawal.id,
          after: { amount, reason, refundTransactionId: refund.id },
        });
        notice = {
          userId: withdrawal.customerId,
          title: 'Chuyển tiền không thành công',
          message: `Lệnh rút ${amount.toLocaleString('vi-VN')} ₫ không chuyển được: ${reason}. Số tiền đã được hoàn lại vào ví của bạn.`,
          type: 'WALLET_WITHDRAWAL_FAILED',
          referenceId: withdrawal.id,
        };
        return withdrawal;
      }

      // Still in flight at the provider: keep what we learned, decide later.
      await withdrawalRepo.save(withdrawal);
      return withdrawal;
    });

    this.notify(notice);
    return settled;
  }

  private async recordUnknown(withdrawalId: string, reason: string): Promise<CustomerWithdrawalRequest> {
    await this.withdrawalRepo.update(
      { id: withdrawalId, status: WithdrawalStatus.PROCESSING },
      { payoutState: 'UNKNOWN', failureReason: `Chưa xác nhận được với payOS: ${reason}`.slice(0, 1000) },
    );
    return this.withdrawalRepo.findOneByOrFail({ id: withdrawalId });
  }

  // ------------------------------------------------------------ reconciliation

  /** Ask the provider about one customer withdrawal still in flight. */
  async reconcile(withdrawalId: string): Promise<CustomerWithdrawalRequest> {
    const withdrawal = await this.withdrawalRepo.findOne({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    if (withdrawal.status !== WithdrawalStatus.PROCESSING) return withdrawal;

    let result: PayoutResult | null;
    try {
      result = await this.provider.findPayoutByReference(referenceIdFor(withdrawal.id));
    } catch (error) {
      this.logger.warn(
        `Could not look up payout for customer withdrawal ${withdrawal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return withdrawal;
    }
    if (result) return this.settle(withdrawal.id, result.outcome, result);

    // The provider never heard of it and a delayed request can no longer
    // arrive: the money did not leave, so it goes back to the customer.
    const attemptedAt = withdrawal.payoutAttemptedAt ?? withdrawal.requestedAt;
    if (attemptedAt && Date.now() - new Date(attemptedAt).getTime() > PAYOUT_NOT_FOUND_GRACE_MS) {
      return this.settle(withdrawal.id, 'FAILED', null, 'Lệnh chi không tới được payOS');
    }
    return withdrawal;
  }

  /** One pass over customer withdrawals still PROCESSING. Never runs twice at once. */
  async reconcileProcessing(): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    try {
      const inFlight = await this.withdrawalRepo.find({
        where: { status: WithdrawalStatus.PROCESSING },
        order: { payoutAttemptedAt: 'ASC' },
        take: RECONCILE_BATCH_SIZE,
      });
      for (const withdrawal of inFlight) {
        try {
          await this.reconcile(withdrawal.id);
        } catch (error) {
          this.logger.error(
            `Reconciling customer withdrawal ${withdrawal.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return inFlight.length;
    } finally {
      this.reconciling = false;
    }
  }

  private notify(notice: Notice | null): void {
    if (!notice || !this.notificationsService) return;
    void this.notificationsService
      .createNotification({ ...notice, referenceType: 'CUSTOMER_WITHDRAWAL' })
      .catch((error: unknown) =>
        this.logger.warn(
          `Customer withdrawal notification failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
}

/** Derived from the id, never random, so a lost response can be found again. */
function referenceIdFor(withdrawalId: string): string {
  return withdrawalId.replace(/-/g, '');
}

export function toCustomerWithdrawalResponse(w: CustomerWithdrawalRequest): CustomerWithdrawalResponseDto {
  return {
    id: w.id,
    amount: Number(w.amount),
    status: w.status,
    bankName: w.bankName,
    bankAccountNumber: maskAccountNumber(w.bankAccountNumber),
    bankAccountName: w.bankAccountName,
    requestedAt: w.requestedAt,
    payoutAttemptedAt: w.payoutAttemptedAt ?? null,
    payoutBankReference: w.payoutBankReference ?? null,
    // While PROCESSING the column holds the provider's raw error for support;
    // the customer only sees a reason once the payout has actually failed.
    failureReason: w.status === WithdrawalStatus.FAILED ? (w.failureReason ?? null) : null,
    refundTransactionId: w.refundTransactionId ?? null,
    updatedAt: w.updatedAt,
  };
}

export type CustomerStaffWithdrawal = CustomerWithdrawalResponseDto & {
  payoutState: string | null;
  customer: { id: string; fullName: string; email: string; phoneNumber: string | null } | null;
};

/**
 * The staff view keeps the provider's raw reason even while PROCESSING (support
 * needs it); the customer view hides it until the payout has really failed.
 */
export function toStaffCustomerWithdrawalResponse(
  w: CustomerWithdrawalRequest,
  user?: Pick<User, 'id' | 'fullName' | 'email' | 'phoneNumber'>,
): CustomerStaffWithdrawal {
  return {
    ...toCustomerWithdrawalResponse(w),
    failureReason: w.failureReason ?? null,
    payoutState: w.payoutState ?? null,
    customer: user ? { id: user.id, fullName: user.fullName, email: user.email, phoneNumber: user.phoneNumber ?? null } : null,
  };
}

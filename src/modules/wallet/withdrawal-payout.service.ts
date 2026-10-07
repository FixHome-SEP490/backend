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
import { maskAccountNumber } from '../../shared/utils/bank-account-mask';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { Role, WalletTransactionType, WithdrawalStatus } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MIN_WITHDRAWAL_AMOUNT } from './dto';
import { TechnicianBankAccount, Wallet, WithdrawalRequest } from './entities';
import {
  PAYOUT_PROVIDER,
  PayoutInstruction,
  PayoutOutcome,
  PayoutProvider,
  PayoutRejectedError,
  PayoutResult,
} from './payout/payout-provider';
import { WalletService } from './wallet.service';

/** How long a payout payOS has never heard of may sit before it is refunded. */
export const PAYOUT_NOT_FOUND_GRACE_MS = 10 * 60 * 1000;

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_BATCH_SIZE = 20;

/** Bank transfer descriptions are short and accent-free on many banks. */
const PAYOUT_DESCRIPTION = 'FixHome Cashout';

type Notice = { userId: string; title: string; message: string; type: string; referenceId: string };

export interface PayoutOverview {
  provider: PayoutProvider['name'];
  sourceBalance: number | null;
  paidOut: { count: number; amount: number };
  processing: { count: number; amount: number };
  pending: { count: number; amount: number };
  failed: { count: number; amount: number };
}

/**
 * Withdrawals, paid out the moment the technician asks. No approval step.
 *
 * The rule every path here keeps: the technician's wallet is debited if and
 * only if money is on its way to their bank. Concretely —
 *
 *  1. The payout source is checked *before* the wallet is touched, so a short
 *     source never debits anyone.
 *  2. The withdrawal is created PROCESSING and the wallet debited in one
 *     transaction, before payOS is called. A payout is therefore never sent
 *     for money still in the wallet.
 *  3. After the call:
 *       payOS paid           -> SUCCESS
 *       payOS refused        -> FAILED, amount returned to the wallet
 *       no clear answer      -> stays PROCESSING; the reconciler asks payOS
 *                               later and only then settles. Refunding on a
 *                               timeout could pay the technician twice.
 *  4. Settling locks the row and only acts on PROCESSING, and the refund has
 *     its own idempotency key, so the request and the reconciler racing to
 *     settle the same withdrawal still refund at most once.
 */
@Injectable()
export class WithdrawalPayoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalPayoutService.name);
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    @InjectRepository(WithdrawalRequest)
    private readonly withdrawalRepo: Repository<WithdrawalRequest>,
    @InjectRepository(TechnicianBankAccount)
    private readonly bankAccountRepo: Repository<TechnicianBankAccount>,
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    const interval = Number(
      this.config.get<string>('PAYOUT_RECONCILE_INTERVAL_MS') ??
        DEFAULT_RECONCILE_INTERVAL_MS,
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

  // ----------------------------------------------------------------- withdraw

  /**
   * A technician withdraws: checked, debited and paid out in the same request.
   *
   * PO decision (30/09/2026): there is no approval step. Service Managers and
   * Admins track the money leaving; they do not approve it. What keeps this
   * safe without a human in the loop is that the money can only ever go to the
   * technician's saved account, whose holder name had to match the KYC name.
   *
   * Returns the withdrawal in whatever state the payout reached — SUCCESS,
   * PROCESSING (payOS has not confirmed yet) or FAILED (money refunded) — so
   * the technician is told at once what happened.
   */
  async withdraw(technicianId: string, amount: number): Promise<WithdrawalRequest> {
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

    const bankAccount = await this.bankAccountRepo.findOne({
      where: { technicianId },
    });
    if (!bankAccount) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Bạn cần khai báo tài khoản ngân hàng nhận tiền trước khi rút tiền',
      );
    }

    // The id is chosen here so the payout reference exists before anything is
    // written, and a lost payOS response can always be looked up by it.
    const withdrawalId = randomUUID();
    const instruction: PayoutInstruction = {
      referenceId: withdrawalId.replace(/-/g, ''),
      amount,
      description: PAYOUT_DESCRIPTION,
      toBin: bankAccount.bankBin,
      toAccountNumber: bankAccount.accountNumber,
    };

    await this.assertSourceCanPay(instruction);
    await this.openAndDebit(withdrawalId, technicianId, amount, bankAccount);
    return this.sendPayout(withdrawalId, instruction);
  }

  /**
   * Hand a PROCESSING withdrawal to the provider and settle on its answer.
   * The money is already out of the wallet when this runs.
   */
  private async sendPayout(
    withdrawalId: string,
    instruction: PayoutInstruction,
  ): Promise<WithdrawalRequest> {
    try {
      const result = await this.provider.createPayout(
        instruction,
        withdrawalId,
      );
      return await this.settle(withdrawalId, result.outcome, result);
    } catch (error) {
      if (error instanceof PayoutRejectedError) {
        return this.settle(withdrawalId, 'FAILED', null, error.message);
      }
      // Unknown: leave it PROCESSING and let the reconciler find out.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Payout for withdrawal ${withdrawalId} has no confirmed outcome yet: ${reason}`,
      );
      return this.recordUnknown(withdrawalId, reason);
    }
  }

  /** Refuse before debiting anyone when the source clearly cannot pay. */
  private async assertSourceCanPay(instruction: PayoutInstruction): Promise<void> {
    const [needed, available] = await Promise.all([
      this.provider.estimateCredit(instruction),
      this.provider.getSourceBalance(),
    ]);
    // An unreadable balance is not a reason to block: payOS itself will refuse
    // an unaffordable payout, and that path refunds cleanly.
    if (available !== null && available < needed) {
      // The platform's own balance is not the technician's business; they get
      // a plain "try later", the figures go to the log for whoever tops it up.
      this.logger.warn(
        `Payout source short: has ${available}, needs ${needed}. Top up the payOS wallet.`,
      );
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Hệ thống chi hộ tạm thời chưa đủ tiền để chi lệnh này. Số dư ví của bạn không bị trừ, vui lòng thử lại sau.',
      );
    }
  }

  /**
   * Create the withdrawal already PROCESSING and debit the wallet, as one
   * transaction under the wallet row lock: the balance cannot move between the
   * check and the debit, and a payout is never sent for money still in the
   * wallet.
   */
  private async openAndDebit(
    withdrawalId: string,
    technicianId: string,
    amount: number,
    bankAccount: TechnicianBankAccount,
  ): Promise<void> {
    const wallet = await this.walletService.getOrCreateWallet(technicianId);
    const minimumBalance = await this.walletService.getMinimumBalance();

    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.getRepository(Wallet).findOne({
        where: { id: wallet.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new NotFoundException('Ví không tồn tại');
      }

      const withdrawalRepo = manager.getRepository(WithdrawalRequest);
      // One open withdrawal per wallet. The unique index enforces the same,
      // this only turns it into a readable message.
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

      const withdrawable = Math.max(Number(locked.balance) - minimumBalance, 0);
      if (amount > withdrawable) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          `Số tiền rút tối đa hiện tại là ${withdrawable.toLocaleString('vi-VN')} ₫ (phải giữ lại tối thiểu ${minimumBalance.toLocaleString('vi-VN')} ₫ trong ví)`,
        );
      }

      const now = new Date();
      await withdrawalRepo.save(
        withdrawalRepo.create({
          id: withdrawalId,
          walletId: locked.id,
          technicianId,
          amount,
          bankBin: bankAccount.bankBin,
          bankName: bankAccount.bankName,
          bankAccountNumber: bankAccount.accountNumber,
          bankAccountName: bankAccount.accountName,
          status: WithdrawalStatus.PROCESSING,
          requestedAt: now,
          processedAt: now,
          processedByUserId: null,
          payoutAttemptedAt: now,
        }),
      );

      const { transaction } = await this.walletService.mutateBalance({
        walletId: locked.id,
        type: WalletTransactionType.WITHDRAW,
        amount,
        referenceType: 'WITHDRAWAL_REQUEST',
        referenceId: withdrawalId,
        idempotencyKey: `WITHDRAW:${withdrawalId}`,
        description: `Rút tiền về ${bankAccount.bankName} - STK ${maskAccountNumber(bankAccount.accountNumber)}`,
        allowNegative: false,
        manager,
      });
      await withdrawalRepo.update({ id: withdrawalId }, { transactionId: transaction.id });

      await this.auditLogService.logWithManager(manager, {
        actorUserId: technicianId,
        actorRole: Role.TECHNICIAN,
        action: 'WITHDRAWAL_REQUESTED',
        resourceType: 'withdrawal_request',
        resourceId: withdrawalId,
        after: {
          amount,
          balanceAfter: transaction.balanceAfter,
          bankCode: bankAccount.bankCode,
          accountNumberTail: bankAccount.accountNumber.slice(-4),
          payoutProvider: this.provider.name,
        },
      });
    });
  }

  // -------------------------------------------------------------- settlement

  /**
   * Move a PROCESSING withdrawal to its final state. Safe to call more than
   * once and from more than one place: anything no longer PROCESSING is left
   * exactly as it is.
   */
  private async settle(
    withdrawalId: string,
    outcome: PayoutOutcome,
    result: PayoutResult | null,
    rejection?: string,
  ): Promise<WithdrawalRequest> {
    let notice: Notice | null = null;

    const settled = await this.dataSource.transaction(async (manager) => {
      const withdrawalRepo = manager.getRepository(WithdrawalRequest);
      const withdrawal = await withdrawalRepo.findOne({
        where: { id: withdrawalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!withdrawal) {
        throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
      }
      if (withdrawal.status !== WithdrawalStatus.PROCESSING) {
        return withdrawal;
      }

      if (result) {
        withdrawal.payoutId = result.payoutId ?? withdrawal.payoutId ?? null;
        withdrawal.payoutState = result.providerState;
        withdrawal.payoutBankReference =
          result.bankReference ?? withdrawal.payoutBankReference ?? null;
      }
      const amount = Number(withdrawal.amount);

      if (outcome === 'SUCCEEDED') {
        withdrawal.status = WithdrawalStatus.SUCCESS;
        withdrawal.failureReason = null;
        await withdrawalRepo.save(withdrawal);
        await this.auditLogService.logWithManager(manager, {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_PAID_OUT',
          resourceType: 'withdrawal_request',
          resourceId: withdrawal.id,
          after: {
            amount,
            payoutId: withdrawal.payoutId,
            bankReference: withdrawal.payoutBankReference,
          },
        });
        notice = {
          userId: withdrawal.technicianId,
          title: 'Đã chuyển tiền về tài khoản ngân hàng',
          message: `${amount.toLocaleString('vi-VN')} ₫ đã được chuyển về ${withdrawal.bankName ?? 'ngân hàng'} - STK ${maskAccountNumber(withdrawal.bankAccountNumber) ?? ''}.`,
          type: 'WALLET_WITHDRAWAL_PAID',
          referenceId: withdrawal.id,
        };
        return withdrawal;
      }

      if (outcome === 'FAILED') {
        const reason =
          rejection ?? result?.failureReason ?? 'Ngân hàng không nhận lệnh chuyển tiền';
        const wallet = await manager.getRepository(Wallet).findOneByOrFail({
          id: withdrawal.walletId,
        });
        const { transaction } = await this.walletService.mutateBalance({
          walletId: wallet.id,
          type: WalletTransactionType.WITHDRAW_REFUND,
          amount,
          referenceType: 'WITHDRAWAL_REQUEST',
          referenceId: withdrawal.id,
          idempotencyKey: `WITHDRAW_REFUND:${withdrawal.id}`,
          description: `Hoàn tiền rút không thành công - ${reason}`.slice(0, 255),
          manager,
        });
        withdrawal.status = WithdrawalStatus.FAILED;
        withdrawal.failureReason = reason;
        withdrawal.refundTransactionId = transaction.id;
        await withdrawalRepo.save(withdrawal);
        await this.auditLogService.logWithManager(manager, {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_PAYOUT_FAILED',
          resourceType: 'withdrawal_request',
          resourceId: withdrawal.id,
          after: { amount, reason, refundTransactionId: transaction.id },
        });
        notice = {
          userId: withdrawal.technicianId,
          title: 'Chuyển tiền không thành công',
          message: `Lệnh rút ${amount.toLocaleString('vi-VN')} ₫ không chuyển được: ${reason}. Số tiền đã được hoàn lại vào ví của bạn.`,
          type: 'WALLET_WITHDRAWAL_FAILED',
          referenceId: withdrawal.id,
        };
        return withdrawal;
      }

      // Still in flight at payOS: keep what we learned, decide later.
      await withdrawalRepo.save(withdrawal);
      return withdrawal;
    });

    this.notify(notice);
    return settled;
  }

  private async recordUnknown(
    withdrawalId: string,
    reason: string,
  ): Promise<WithdrawalRequest> {
    await this.withdrawalRepo.update(
      { id: withdrawalId, status: WithdrawalStatus.PROCESSING },
      { payoutState: 'UNKNOWN', failureReason: `Chưa xác nhận được với payOS: ${reason}`.slice(0, 1000) },
    );
    return this.withdrawalRepo.findOneByOrFail({ id: withdrawalId });
  }

  // ------------------------------------------------------------ reconciliation

  /** Ask payOS about one withdrawal that is still in flight. */
  async reconcile(withdrawalId: string): Promise<WithdrawalRequest> {
    const withdrawal = await this.withdrawalRepo.findOne({
      where: { id: withdrawalId },
    });
    if (!withdrawal) {
      throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    }
    if (withdrawal.status !== WithdrawalStatus.PROCESSING) {
      return withdrawal;
    }

    let result: PayoutResult | null;
    try {
      result = await this.provider.findPayoutByReference(
        this.referenceIdFor(withdrawal),
      );
    } catch (error) {
      // Not being able to ask is not an answer. Try again next round.
      this.logger.warn(
        `Could not look up payout for withdrawal ${withdrawal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return withdrawal;
    }

    if (result) {
      return this.settle(withdrawal.id, result.outcome, result);
    }

    // payOS has no payout under this reference. Once enough time has passed
    // that a delayed request could no longer arrive, it never will: the money
    // did not leave, so it goes back to the technician.
    const attemptedAt = withdrawal.payoutAttemptedAt ?? withdrawal.processedAt;
    if (
      attemptedAt &&
      Date.now() - new Date(attemptedAt).getTime() > PAYOUT_NOT_FOUND_GRACE_MS
    ) {
      return this.settle(
        withdrawal.id,
        'FAILED',
        null,
        'Lệnh chi không tới được payOS',
      );
    }
    return withdrawal;
  }

  /** One pass over everything still PROCESSING. Never runs twice at once. */
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
            `Reconciling withdrawal ${withdrawal.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return inFlight.length;
    } finally {
      this.reconciling = false;
    }
  }

  // --------------------------------------------------------------- overview

  /** Figures for the console: what left, what is moving, what the source holds. */
  async overview(): Promise<PayoutOverview> {
    const rows = await this.withdrawalRepo
      .createQueryBuilder('w')
      .select('w.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(w.amount), 0)', 'amount')
      .where('w.status IN (:...statuses)', {
        statuses: [
          WithdrawalStatus.SUCCESS,
          WithdrawalStatus.PROCESSING,
          WithdrawalStatus.PENDING,
          WithdrawalStatus.FAILED,
        ],
      })
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

  // ------------------------------------------------------------------ helpers

  /**
   * Derived from the withdrawal id, never random, so a payout whose response
   * was lost can always be found again by the same reference. Must match the
   * referenceId withdraw() sends.
   */
  private referenceIdFor(withdrawal: WithdrawalRequest): string {
    return withdrawal.id.replace(/-/g, '');
  }

  private notify(notice: Notice | null): void {
    if (!notice || !this.notificationsService) return;
    void this.notificationsService
      .createNotification({ ...notice, referenceType: 'WITHDRAWAL_REQUEST' })
      .catch((error: unknown) =>
        this.logger.warn(
          `Withdrawal notification failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
}

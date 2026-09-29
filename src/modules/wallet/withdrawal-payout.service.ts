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
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { WalletTransactionType, WithdrawalStatus } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Wallet, WithdrawalRequest } from './entities';
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
const PAYOUT_DESCRIPTION = 'FixHome rut tien';

interface Actor {
  id: string | null;
  role: string | null;
}

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
 * Approval and payout of withdrawals.
 *
 * The rule every path here keeps: the technician's wallet is debited if and
 * only if money is on its way to their bank. Concretely —
 *
 *  1. Approval checks the payout source can cover it *before* touching the
 *     wallet, so a short source never debits anyone.
 *  2. The debit and the move to PROCESSING commit together, before payOS is
 *     called. A payout is therefore never sent for money still in the wallet.
 *  3. After the call:
 *       payOS paid           -> SUCCESS
 *       payOS refused        -> FAILED, amount returned to the wallet
 *       no clear answer      -> stays PROCESSING; the reconciler asks payOS
 *                               later and only then settles. Refunding on a
 *                               timeout could pay the technician twice.
 *  4. Settling locks the row and only acts on PROCESSING, and the refund has
 *     its own idempotency key, so approval and the reconciler racing to settle
 *     the same withdrawal still refund at most once.
 */
@Injectable()
export class WithdrawalPayoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalPayoutService.name);
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    @InjectRepository(WithdrawalRequest)
    private readonly withdrawalRepo: Repository<WithdrawalRequest>,
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

  // ------------------------------------------------------------------ approve

  /**
   * A Service Manager approves: debit the wallet, then pay out automatically.
   * Returns the withdrawal in whatever state the payout reached — SUCCESS,
   * PROCESSING or FAILED — so the caller can say exactly what happened.
   */
  async approve(withdrawalId: string, actor: Actor): Promise<WithdrawalRequest> {
    const withdrawal = await this.withdrawalRepo.findOne({
      where: { id: withdrawalId },
    });
    if (!withdrawal) {
      throw new NotFoundException('Yêu cầu rút tiền không tồn tại');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new ConflictException('Yêu cầu rút tiền đã được xử lý trước đó');
    }
    if (!withdrawal.bankBin || !withdrawal.bankAccountNumber) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Yêu cầu này được tạo trước khi có chi tiền tự động nên thiếu mã ngân hàng. Hãy từ chối để kỹ thuật viên tạo lại yêu cầu mới.',
      );
    }

    const instruction = this.instructionFor(withdrawal);
    await this.assertSourceCanPay(instruction);
    await this.debitAndMarkProcessing(withdrawalId, actor);

    try {
      const result = await this.provider.createPayout(
        instruction,
        withdrawal.id,
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
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Ví nguồn chi hộ không đủ số dư: còn ${available.toLocaleString('vi-VN')} ₫, cần ${needed.toLocaleString('vi-VN')} ₫. Hãy nạp thêm vào ví Bảo Kim rồi duyệt lại.`,
      );
    }
  }

  private async debitAndMarkProcessing(
    withdrawalId: string,
    actor: Actor,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const withdrawalRepo = manager.getRepository(WithdrawalRequest);
      const withdrawal = await withdrawalRepo.findOne({
        where: { id: withdrawalId },
        lock: { mode: 'pessimistic_write' },
      });
      // Re-checked under the lock: two managers pressing approve at once.
      if (!withdrawal || withdrawal.status !== WithdrawalStatus.PENDING) {
        throw new ConflictException('Yêu cầu rút tiền đã được xử lý trước đó');
      }

      const wallet = await manager.getRepository(Wallet).findOne({
        where: { id: withdrawal.walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Ví không tồn tại');
      }

      // The balance may have moved since the request (platform fees), so the
      // minimum is checked again against what is in the wallet right now.
      const minimumBalance = await this.walletService.getMinimumBalance();
      const amount = Number(withdrawal.amount);
      const remaining = Number(wallet.balance) - amount;
      if (remaining < minimumBalance) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          `Không thể phê duyệt vì số dư còn lại sau khi rút (${remaining.toLocaleString('vi-VN')} ₫) sẽ thấp hơn mức tối thiểu (${minimumBalance.toLocaleString('vi-VN')} ₫)`,
        );
      }

      const { transaction } = await this.walletService.mutateBalance({
        walletId: wallet.id,
        type: WalletTransactionType.WITHDRAW,
        amount,
        referenceType: 'WITHDRAWAL_REQUEST',
        referenceId: withdrawal.id,
        idempotencyKey: `WITHDRAW:${withdrawal.id}`,
        description: `Rút tiền về ${withdrawal.bankName ?? 'ngân hàng'} - STK ${withdrawal.bankAccountNumber ?? ''}`,
        allowNegative: false,
        manager,
      });

      withdrawal.status = WithdrawalStatus.PROCESSING;
      withdrawal.processedAt = new Date();
      withdrawal.processedByUserId = actor.id;
      withdrawal.transactionId = transaction.id;
      withdrawal.payoutAttemptedAt = new Date();
      await withdrawalRepo.save(withdrawal);

      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'WITHDRAWAL_APPROVED',
        resourceType: 'withdrawal_request',
        resourceId: withdrawal.id,
        after: {
          amount,
          technicianId: withdrawal.technicianId,
          balanceAfter: transaction.balanceAfter,
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
          message: `${amount.toLocaleString('vi-VN')} ₫ đã được chuyển về ${withdrawal.bankName ?? 'ngân hàng'} - STK ${withdrawal.bankAccountNumber ?? ''}.`,
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
   * was lost can always be found again by the same reference.
   */
  private referenceIdFor(withdrawal: WithdrawalRequest): string {
    return withdrawal.id.replace(/-/g, '');
  }

  private instructionFor(withdrawal: WithdrawalRequest): PayoutInstruction {
    return {
      referenceId: this.referenceIdFor(withdrawal),
      amount: Number(withdrawal.amount),
      description: PAYOUT_DESCRIPTION,
      toBin: withdrawal.bankBin ?? '',
      toAccountNumber: withdrawal.bankAccountNumber ?? '',
    };
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

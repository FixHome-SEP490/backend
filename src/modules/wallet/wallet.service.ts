import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { maskAccountNumbersInText } from '../../shared/utils/bank-account-mask';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  Role,
  WalletTransactionType,
  WithdrawalStatus,
} from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { User } from '../users/entities/user.entity';
import {
  AdminWalletAdjustmentDto,
  AdjustmentType,
  QueryWalletsDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
  MIN_WITHDRAWAL_AMOUNT,
  WalletSummaryResponseDto,
} from './dto';
import {
  Wallet,
  WalletTransaction,
  WithdrawalRequest,
} from './entities';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(WalletTransaction)
    private readonly transactionRepo: Repository<WalletTransaction>,
    @InjectRepository(WithdrawalRequest)
    private readonly withdrawalRepo: Repository<WithdrawalRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /**
   * Get the system configured minimum balance (default: 200,000 VND).
   */
  async getMinimumBalance(): Promise<number> {
    const minBigInt = await this.configService.getBigInt(
      'wallet.minimum_balance',
      BigInt(200000),
    );
    return Number(minBigInt);
  }

  /**
   * Get or automatically initialize a Wallet for a Technician.
   */
  async getOrCreateWallet(
    technicianId: string,
    manager?: EntityManager,
  ): Promise<Wallet> {
    const repo = manager ? manager.getRepository(Wallet) : this.walletRepo;
    let wallet = await repo.findOne({ where: { technicianId } });
    if (!wallet) {
      wallet = repo.create({
        technicianId,
        balance: 0, // Initial balance is 0 VND for newly registered technician
      });
      wallet = await repo.save(wallet);
      this.logger.log(`Initialized new wallet for technician ${technicianId}`);
    }
    return wallet;
  }

  /**
   * Staff look up a wallet by technician id. The id must belong to a
   * technician: a customer's id used to get a wallet created for them, and an
   * unknown id ran into the foreign key and surfaced as a 500.
   */
  async requireTechnician(technicianId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: technicianId }, select: { id: true, role: true } });
    if (!user || user.role !== Role.TECHNICIAN) {
      throw new NotFoundException('Không tìm thấy kỹ thuật viên');
    }
  }

  async getTechnicianWalletSummary(technicianId: string): Promise<WalletSummaryResponseDto> {
    await this.requireTechnician(technicianId);
    return this.getWalletSummary(technicianId);
  }

  /**
   * Calculate runtime summary including pending withdrawal and eligibility.
   */
  async getWalletSummary(technicianId: string): Promise<WalletSummaryResponseDto> {
    const wallet = await this.getOrCreateWallet(technicianId);
    const minimumBalance = await this.getMinimumBalance();

    const pendingWithdrawal = await this.sumWithdrawals(
      technicianId,
      WithdrawalStatus.PENDING,
    );
    // Already debited from balance when approved, so it is shown but never
    // subtracted a second time below.
    const processingWithdrawal = await this.sumWithdrawals(
      technicianId,
      WithdrawalStatus.PROCESSING,
    );
    const balance = Number(wallet.balance);
    const availableBalance = balance - pendingWithdrawal;
    const withdrawableBalance = Math.max(availableBalance - minimumBalance, 0);
    const eligibleForJobs = balance >= minimumBalance;

    return {
      id: wallet.id,
      technicianId,
      balance,
      pendingWithdrawal,
      processingWithdrawal,
      minimumBalance,
      minimumWithdrawal: MIN_WITHDRAWAL_AMOUNT,
      availableBalance,
      withdrawableBalance,
      eligibleForJobs,
    };
  }

  private async sumWithdrawals(
    technicianId: string,
    status: WithdrawalStatus,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager
      ? manager.getRepository(WithdrawalRequest)
      : this.withdrawalRepo;
    const row = await repo
      .createQueryBuilder('w')
      .select('COALESCE(SUM(w.amount), 0)', 'total')
      .where('w.technician_id = :technicianId AND w.status = :status', {
        technicianId,
        status,
      })
      .getRawOne<{ total: string }>();
    return Number(row?.total || 0);
  }

  /**
   * Authoritative check whether a technician has sufficient balance to accept new jobs.
   */
  async isEligibleForJobs(
    technicianId: string,
    manager?: EntityManager,
  ): Promise<{ eligible: boolean; balance: number; minimumBalance: number }> {
    const wallet = await this.getOrCreateWallet(technicianId, manager);
    const minimumBalance = await this.getMinimumBalance();
    const balance = Number(wallet.balance);
    return {
      eligible: balance >= minimumBalance,
      balance,
      minimumBalance,
    };
  }

  /**
   * Central balance mutation method.
   * STRICT: Uses row-level pessimistic locking, idempotency check, and immutable transaction ledger.
   */
  async mutateBalance(params: {
    walletId: string;
    type: WalletTransactionType;
    amount: number;
    referenceType?: string | null;
    referenceId?: string | null;
    idempotencyKey: string;
    description?: string | null;
    allowNegative?: boolean;
    /** ADJUSTMENT only: take the amount off instead of adding it. */
    debit?: boolean;
    manager?: EntityManager;
  }): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    const {
      walletId,
      type,
      amount,
      referenceType,
      referenceId,
      idempotencyKey,
      description,
      allowNegative = false,
      debit = false,
      manager: externalManager,
    } = params;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Giao dịch ví yêu cầu số tiền nguyên dương hợp lệ',
      );
    }

    const runInManager = async (manager: EntityManager) => {
      const walletRepo = manager.getRepository(Wallet);
      const txRepo = manager.getRepository(WalletTransaction);

      // 1. Check idempotency
      const existingTx = await txRepo.findOne({
        where: { idempotencyKey },
      });
      if (existingTx) {
        this.logger.warn(
          `Idempotent duplicate ignored: ${idempotencyKey} already posted`,
        );
        const currentWallet = await walletRepo.findOneByOrFail({ id: walletId });
        return { wallet: currentWallet, transaction: existingTx };
      }

      // 2. Lock wallet row exclusively
      const wallet = await walletRepo.findOne({
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Ví không tồn tại');
      }

      const balanceBefore = Number(wallet.balance);
      let balanceAfter = balanceBefore;

      switch (type) {
        case WalletTransactionType.TOP_UP:
        case WalletTransactionType.ONLINE_EARNING:
        case WalletTransactionType.WITHDRAW_REFUND:
          balanceAfter = balanceBefore + amount;
          break;
        case WalletTransactionType.WITHDRAW:
        case WalletTransactionType.PLATFORM_FEE:
          balanceAfter = balanceBefore - amount;
          break;
        case WalletTransactionType.ADJUSTMENT:
          // The amount is always positive; the direction shows in balanceBefore/After.
          balanceAfter = debit ? balanceBefore - amount : balanceBefore + amount;
          break;
        default:
          throw new BusinessException(
            ErrorCodes.VALIDATION_FAILED,
            'Loại giao dịch ví không được hỗ trợ',
          );
      }

      if (!allowNegative && balanceAfter < 0) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Số dư ví không đủ để thực hiện giao dịch này',
        );
      }

      wallet.balance = balanceAfter;
      const updatedWallet = await walletRepo.save(wallet);

      const transaction = txRepo.create({
        walletId: wallet.id,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
        idempotencyKey,
        description: description ?? null,
      });
      const savedTx = await txRepo.save(transaction);

      // Threshold crossing notification
      const minimumBalance = await this.getMinimumBalance();
      if (this.notificationsService) {
        if (balanceBefore >= minimumBalance && balanceAfter < minimumBalance) {
          void this.notificationsService.createNotification({
            userId: wallet.technicianId,
            title: 'Số dư ví dưới mức tối thiểu',
            message: `Số dư ví hiện tại (${balanceAfter.toLocaleString('vi-VN')} ₫) dưới mức tối thiểu (${minimumBalance.toLocaleString('vi-VN')} ₫). Bạn tạm thời không thể nhận đơn mới. Vui lòng nạp thêm để tiếp tục.`,
            type: 'WALLET_BELOW_MINIMUM',
            referenceId: savedTx.id,
            referenceType: 'WALLET_TRANSACTION',
          });
        } else if (
          balanceBefore < minimumBalance &&
          balanceAfter >= minimumBalance
        ) {
          void this.notificationsService.createNotification({
            userId: wallet.technicianId,
            title: 'Ví đã đủ điều kiện nhận việc',
            message: `Số dư ví của bạn (${balanceAfter.toLocaleString('vi-VN')} ₫) đã đạt mức tối thiểu. Bạn có thể tiếp tục nhận đơn sửa chữa mới.`,
            type: 'WALLET_ABOVE_MINIMUM',
            referenceId: savedTx.id,
            referenceType: 'WALLET_TRANSACTION',
          });
        }
      }

      return { wallet: updatedWallet, transaction: savedTx };
    };

    if (externalManager) {
      return runInManager(externalManager);
    }
    return this.dataSource.transaction(runInManager);
  }

  /**
   * Top up wallet.
   */
  async topUp(
    technicianId: string,
    amount: number,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    const wallet = await this.getOrCreateWallet(technicianId, manager);
    const result = await this.mutateBalance({
      walletId: wallet.id,
      type: WalletTransactionType.TOP_UP,
      amount,
      idempotencyKey,
      description: `Nạp tiền vào ví Kỹ thuật viên: +${amount.toLocaleString('vi-VN')} ₫`,
      referenceType: 'TOP_UP',
      referenceId: idempotencyKey,
      manager,
    });

    if (this.notificationsService) {
      void this.notificationsService.createNotification({
        userId: technicianId,
        title: 'Nạp tiền vào ví thành công',
        message: `Bạn vừa nạp thành công +${amount.toLocaleString('vi-VN')} ₫ vào ví. Số dư hiện tại: ${result.wallet.balance.toLocaleString('vi-VN')} ₫.`,
        type: 'WALLET_TOP_UP_SUCCESS',
        referenceId: result.transaction.id,
        referenceType: 'WALLET_TRANSACTION',
      });
    }

    return result;
  }

  /**
   * Admin: Adjust wallet balance with strict audit logging.
   */
  async adminAdjustBalance(
    technicianId: string,
    dto: AdminWalletAdjustmentDto,
    actor: { id: string; role: string },
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    if (!dto.reason?.trim()) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Lý do điều chỉnh số dư ví là bắt buộc',
      );
    }

    await this.requireTechnician(technicianId);
    const wallet = await this.getOrCreateWallet(technicianId);
    const amount = Math.abs(dto.amount);
    const idempotencyKey = `ADJUSTMENT:${technicianId}:${Date.now()}`;

    return this.dataSource.transaction(async (manager) => {
      const result = await this.mutateBalance({
        walletId: wallet.id,
        type: WalletTransactionType.ADJUSTMENT,
        amount,
        referenceType: 'ADMIN_ADJUSTMENT',
        referenceId: actor.id,
        idempotencyKey,
        debit: dto.type !== AdjustmentType.CREDIT,
        description: `Admin điều chỉnh (${dto.type === AdjustmentType.CREDIT ? '+' : '-'}${Math.abs(dto.amount).toLocaleString('vi-VN')} ₫): ${dto.reason.trim()}`,
        allowNegative: false,
        manager,
      });

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'WALLET_ADJUSTMENT',
        resourceType: 'wallet',
        resourceId: wallet.id,
        before: { balance: result.transaction.balanceBefore },
        after: {
          balance: result.transaction.balanceAfter,
          type: dto.type,
          amount: dto.amount,
          reason: dto.reason,
        },
      });

      if (this.notificationsService) {
        void this.notificationsService.createNotification({
          userId: technicianId,
          title: 'Số dư ví đã được điều chỉnh',
          message: `Quản trị viên đã ${dto.type === AdjustmentType.CREDIT ? 'cộng' : 'trừ'} ${dto.amount.toLocaleString('vi-VN')} ₫ trong ví của bạn. Lý do: "${dto.reason}". Số dư hiện tại: ${result.transaction.balanceAfter.toLocaleString('vi-VN')} ₫.`,
          type: 'WALLET_ADJUSTED',
          referenceId: result.transaction.id,
          referenceType: 'WALLET_TRANSACTION',
        });
      }

      return result;
    });
  }

  /**
   * List paginated transactions for a wallet.
   */
  async listTransactions(
    walletId: string,
    query: QueryWalletTransactionsDto,
  ): Promise<{ data: WalletTransaction[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;

    const qb = this.transactionRepo
      .createQueryBuilder('tx')
      .where('tx.wallet_id = :walletId', { walletId });

    if (query.type) {
      qb.andWhere('tx.type = :type', { type: query.type });
    }

    qb.orderBy('tx.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map((row) => Object.assign(Object.create(Object.getPrototypeOf(row) as object) as WalletTransaction, row, {
      description: maskAccountNumbersInText(row.description),
    }));
    return { data, total };
  }

  /**
   * List technician wallets for Service Manager & Admin.
   */
  async listWallets(
    query: QueryWalletsDto,
  ): Promise<{ data: any[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const minimumBalance = await this.getMinimumBalance();

    const qb = this.walletRepo
      .createQueryBuilder('w')
      .leftJoinAndSelect('w.technician', 'u')
      .where('u.role = :role', { role: Role.TECHNICIAN });

    if (query.search?.trim()) {
      qb.andWhere(
        '(u.fullName ILIKE :search OR u.phoneNumber ILIKE :search OR u.email ILIKE :search)',
        { search: `%${query.search.trim()}%` },
      );
    }

    if (query.eligible === 'true') {
      qb.andWhere('w.balance >= :min', { min: minimumBalance });
    } else if (query.eligible === 'false') {
      qb.andWhere('w.balance < :min', { min: minimumBalance });
    }

    qb.orderBy('w.updatedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [wallets, total] = await qb.getManyAndCount();

    const data = wallets.map((w) => {
      const balance = Number(w.balance);
      return {
        id: w.id,
        technicianId: w.technicianId,
        balance,
        minimumBalance,
        eligibleForJobs: balance >= minimumBalance,
        technician: w.technician
          ? {
              id: w.technician.id,
              fullName: w.technician.fullName,
              phoneNumber: w.technician.phoneNumber,
              email: w.technician.email,
              avatarUrl: w.technician.avatarUrl,
            }
          : null,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      };
    });

    return { data, total };
  }

  /**
   * List withdrawal requests for Service Manager & Admin.
   */
  async listWithdrawals(
    query: QueryWithdrawalsDto,
  ): Promise<{ data: WithdrawalRequest[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;

    const qb = this.withdrawalRepo
      .createQueryBuilder('w')
      .leftJoinAndSelect('w.technician', 'u');

    if (query.status) {
      qb.andWhere('w.status = :status', { status: query.status });
    }

    qb.orderBy('w.requestedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /**
   * List technician's own withdrawal history.
   */
  async listMyWithdrawals(
    technicianId: string,
    query: QueryWithdrawalsDto,
  ): Promise<{ data: WithdrawalRequest[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;

    const [data, total] = await this.withdrawalRepo.findAndCount({
      where: { technicianId },
      order: { requestedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }
}

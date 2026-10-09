import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { CustomerWallet } from './entities/customer-wallet.entity';
import { CustomerWalletTransaction, type CustomerWalletTransactionType } from './entities/customer-wallet-transaction.entity';

export interface CustomerWalletEntry {
  userId: string;
  type: CustomerWalletTransactionType;
  /** Whole VND, positive. */
  amount: number;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
}

const INCOMING: CustomerWalletTransactionType[] = ['top_up', 'refund'];

/**
 * The customer wallet ledger (PO 08/10/2026). Money comes in by top-up or
 * refund and goes out only to pay the customer's own invoices; there is no
 * withdrawal. Every change locks the wallet row and appends one transaction
 * whose idempotency key makes a retry return the first result.
 */
@Injectable()
export class CustomerWalletService {
  constructor(
    @InjectRepository(CustomerWallet) private readonly walletRepo: Repository<CustomerWallet>,
    @InjectRepository(CustomerWalletTransaction) private readonly txRepo: Repository<CustomerWalletTransaction>,
    private readonly dataSource: DataSource,
  ) {}

  async getOrCreate(manager: EntityManager, userId: string): Promise<CustomerWallet> {
    await manager.query(
      `INSERT INTO "customer_wallets" ("user_id") VALUES ($1) ON CONFLICT ("user_id") DO NOTHING`,
      [userId],
    );
    return manager.findOneOrFail(CustomerWallet, { where: { userId } });
  }

  /** Applies one entry inside the caller's transaction. */
  async apply(manager: EntityManager, entry: CustomerWalletEntry): Promise<CustomerWalletTransaction> {
    if (!Number.isSafeInteger(entry.amount) || entry.amount <= 0) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Số tiền phải là số nguyên dương');
    }
    const existing = await manager.findOne(CustomerWalletTransaction, { where: { idempotencyKey: entry.idempotencyKey } });
    if (existing) return existing;
    const { id } = await this.getOrCreate(manager, entry.userId);
    const wallet = await manager.findOneOrFail(CustomerWallet, { where: { id }, lock: { mode: 'pessimistic_write' } });
    // Checked again under the lock: two concurrent retries must not both apply.
    const raced = await manager.findOne(CustomerWalletTransaction, { where: { idempotencyKey: entry.idempotencyKey } });
    if (raced) return raced;
    const before = Number(wallet.balance);
    const after = INCOMING.includes(entry.type) ? before + entry.amount : before - entry.amount;
    if (after < 0) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Số dư ví không đủ để thanh toán, vui lòng nạp thêm', {
        balance: before,
        required: entry.amount,
      });
    }
    await manager.update(CustomerWallet, wallet.id, { balance: after });
    return manager.save(CustomerWalletTransaction, manager.create(CustomerWalletTransaction, {
      walletId: wallet.id,
      type: entry.type,
      amount: entry.amount,
      balanceBefore: before,
      balanceAfter: after,
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      idempotencyKey: entry.idempotencyKey,
      description: entry.description ?? null,
    }));
  }

  /** Total already refunded against one service order, so refunds never exceed what was paid. */
  async refundedForOrder(manager: EntityManager, serviceOrderId: string): Promise<number> {
    const [row] = await manager.query(
      `SELECT COALESCE(SUM("amount"), 0) AS total FROM "customer_wallet_transactions" WHERE "type" = 'refund' AND "reference_type" = 'SERVICE_ORDER' AND "reference_id" = $1`,
      [serviceOrderId],
    );
    return Number(row?.total ?? 0);
  }

  async summary(userId: string, page = 1, pageSize = 20) {
    const wallet = await this.walletRepo.findOne({ where: { userId } });
    if (!wallet) return { balance: 0, transactions: [], meta: { page: 1, limit: pageSize, total: 0, totalPages: 0 } };
    const safePage = Math.max(1, Math.floor(page) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(pageSize) || 20));
    const [rows, total] = await this.txRepo.findAndCount({
      where: { walletId: wallet.id },
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * limit,
      take: limit,
    });
    return {
      balance: Number(wallet.balance),
      transactions: rows.map((t) => ({
        id: t.id, type: t.type, amount: Number(t.amount), balanceAfter: Number(t.balanceAfter),
        description: t.description, referenceType: t.referenceType, referenceId: t.referenceId, createdAt: t.createdAt,
      })),
      meta: { page: safePage, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async balanceOf(userId: string): Promise<number> {
    const wallet = await this.walletRepo.findOne({ where: { userId } });
    return wallet ? Number(wallet.balance) : 0;
  }

  /** Runs entries in their own transaction (used where no caller transaction exists). */
  async applyStandalone(entry: CustomerWalletEntry): Promise<CustomerWalletTransaction> {
    return this.dataSource.transaction((manager) => this.apply(manager, entry));
  }
}

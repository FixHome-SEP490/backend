import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { foldVietnamese, VN_FROM, VN_TO } from '../technicians/admin-technicians.service';
import { CustomerWalletService } from './customer-wallet.service';

export interface CustomerWalletAdjustment {
  type: 'CREDIT' | 'DEBIT';
  amount: number;
  reason: string;
}

/**
 * Admin side of the customer wallets (PO 09/10/2026): every customer's
 * balance, one customer's history, and a correction with a reason. FixHome
 * bears refunds; a correction is the admin's tool to fix a mistake, never a
 * withdrawal to the customer.
 */
@Injectable()
export class AdminCustomerWalletsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly wallets: CustomerWalletService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: { search?: string; page?: number; pageSize?: number; withBalance?: boolean }) {
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 20));
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const where = [`u."role" = 'customer'`];
    const text = query.search?.trim().slice(0, 100) ?? '';
    if (text) {
      const folded = add(`%${foldVietnamese(text)}%`);
      const like = add(`%${text}%`);
      const any = [
        `translate(lower(u."full_name"), '${VN_FROM}', '${VN_TO}') LIKE ${folded}`,
        `u."email" ILIKE ${like}`,
      ];
      const digits = text.replace(/\D/g, '');
      if (digits.length >= 3) {
        const local = digits.startsWith('84') && digits.length >= 10 ? '0' + digits.slice(2) : digits;
        any.push(`regexp_replace(COALESCE(u."phone_number", ''), '\\D', '', 'g') LIKE ${add(`%${local}%`)}`);
      }
      where.push(`(${any.join(' OR ')})`);
    }
    if (query.withBalance) where.push(`COALESCE(w."balance", 0) > 0`);
    const from = `FROM "users" u LEFT JOIN "customer_wallets" w ON w."user_id" = u."id" WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const [{ sum }] = await this.dataSource.query(`SELECT COALESCE(SUM(w."balance"), 0)::bigint AS sum ${from}`, params);
    const rows = await this.dataSource.query(
      `SELECT u."id" AS "userId", u."full_name" AS "fullName", u."email", u."phone_number" AS "phoneNumber", u."status",
              COALESCE(w."balance", 0) AS "balance", w."updated_at" AS "updatedAt"
         ${from}
        ORDER BY COALESCE(w."balance", 0) DESC, u."full_name" ASC, u."id" ASC
        LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
      params,
    );
    return {
      data: rows.map((r: Record<string, unknown>) => ({ ...r, balance: Number(r.balance) })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), totalBalance: Number(sum) },
    };
  }

  async detail(userId: string, page = 1, pageSize = 20) {
    const customer = await this.requireCustomer(userId);
    return { customer, ...(await this.wallets.summary(userId, page, pageSize)) };
  }

  async adjust(userId: string, dto: CustomerWalletAdjustment, actor: { id: string; role: string }) {
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 10) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Lý do điều chỉnh tối thiểu 10 ký tự');
    }
    await this.requireCustomer(userId);
    const credit = dto.type === 'CREDIT';
    const sign = credit ? '+' : '-';
    const amountText = `${dto.amount.toLocaleString('vi-VN')} ₫`;
    const tx = await this.dataSource.transaction(async (manager) => {
      const entry = await this.wallets.apply(manager, {
        userId,
        type: credit ? 'adjustment_credit' : 'adjustment_debit',
        amount: dto.amount,
        idempotencyKey: `CADJUST:${userId}:${randomUUID()}`,
        referenceType: 'ADMIN_ADJUSTMENT',
        referenceId: actor.id,
        description: `Quản trị viên điều chỉnh (${sign}${amountText}): ${reason}`,
      });
      await this.auditLog.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'CUSTOMER_WALLET_ADJUSTMENT',
        resourceType: 'customer_wallet',
        resourceId: entry.walletId,
        before: { balance: Number(entry.balanceBefore) },
        after: { balance: Number(entry.balanceAfter), type: dto.type, amount: dto.amount, reason },
      });
      return entry;
    });
    void this.notifications.createNotification({
      userId,
      title: 'Số dư ví đã được điều chỉnh',
      message: `FixHome đã ${credit ? 'cộng' : 'trừ'} ${amountText} trong ví của bạn. Lý do: "${reason}". Số dư hiện tại: ${Number(tx.balanceAfter).toLocaleString('vi-VN')} ₫.`,
      type: 'WALLET_ADJUSTED',
      referenceId: tx.id,
      referenceType: 'CUSTOMER_WALLET_TRANSACTION',
    }).catch(() => undefined);
    return { userId, transactionId: tx.id, balanceAfter: Number(tx.balanceAfter) };
  }

  private async requireCustomer(userId: string) {
    const [customer] = await this.dataSource.query(
      `SELECT "id", "full_name" AS "fullName", "email", "phone_number" AS "phoneNumber", "status"
         FROM "users" WHERE "id" = $1 AND "role" = 'customer'`,
      [userId],
    );
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');
    return customer;
  }
}

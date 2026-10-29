import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';

export interface VoucherCustomerRefundSource {
  readonly customerId: string;
  readonly serviceOrderId: string;
  readonly refundSourceId: string;
  readonly invoiceId: string;
  /** Approved, persisted customer NET amount; never original invoice gross. */
  readonly netVnd: number;
}

/** Called only after the voucher refund source and allocation have been checked. */
export async function creditVoucherCustomerRefund(
  manager: EntityManager,
  customerWalletService: CustomerWalletService,
  source: VoucherCustomerRefundSource,
): Promise<CustomerWalletTransaction> {
  const inconsistent = () => { throw new ConflictException('Nguồn hoàn tiền ví không nhất quán.'); };
  if (!manager.queryRunner?.isTransactionActive ||
      !Number.isSafeInteger(source.netVnd) || source.netVnd <= 0 ||
      !source.customerId || !source.serviceOrderId ||
      !source.refundSourceId || !source.invoiceId) inconsistent();
  const key = `REFUND:${source.refundSourceId}:${source.invoiceId}:CUSTOMER_REFUND`;
  // A committed wallet credit without its immutable journal is inconsistent.
  // A true replay is handled by the journal branch before this function.
  const existing = await manager.findOne(CustomerWalletTransaction, {
    where: { idempotencyKey: key }, lock: { mode: 'pessimistic_read' },
  });
  if (existing) inconsistent();
  const transaction = await customerWalletService.apply(manager, {
    userId: source.customerId, type: 'refund', amount: source.netVnd,
    idempotencyKey: key, referenceType: 'SERVICE_ORDER',
    referenceId: source.serviceOrderId,
    description: 'Hoàn tiền ưu đãi theo khiếu nại đã xác minh',
  });
  const wallet = transaction && await manager.findOne(CustomerWallet, {
    where: { id: transaction.walletId }, lock: { mode: 'pessimistic_read' },
  });
  if (!transaction || !transaction.id || !wallet || wallet.userId !== source.customerId ||
      !Number.isSafeInteger(transaction.amount) ||
      !Number.isSafeInteger(transaction.balanceBefore) ||
      !Number.isSafeInteger(transaction.balanceAfter) ||
      transaction.type !== 'refund' || transaction.amount !== source.netVnd ||
      transaction.balanceAfter - transaction.balanceBefore !== source.netVnd ||
      transaction.referenceType !== 'SERVICE_ORDER' ||
      transaction.referenceId !== source.serviceOrderId ||
      transaction.idempotencyKey !== key) inconsistent();
  return transaction;
}

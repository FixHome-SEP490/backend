import { voucherAllocationDigest } from './voucher-allocation-digest';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CashSettlementStatus, PaymentStatus, WalletTransactionType } from '../../shared/enums';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import type { WalletService } from '../wallet/wallet.service';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { ReservationState } from './voucher.types';
import { lockVoucherFundingReservation } from './voucher-funding-lock';

function inconsistent(): never {
  throw new ConflictException('Thanh toán tiền mặt và nguồn bù ưu đãi không nhất quán.');
}

function vnd(value: unknown): number {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' ||
      !Number.isSafeInteger(amount) || amount < 0) inconsistent();
  return amount;
}

/**
 * F2 company credit boundary. The Finance confirmation must call this in its
 * existing DB transaction after all invoices are paid and cash is confirmed.
 * It preserves original PlatformDue; the credit is independent company money.
 */
export async function commitConfirmedCashVoucherFunding(
  manager: EntityManager,
  reservationId: string,
  walletService: WalletService,
): Promise<number> {
  if (!manager.queryRunner?.isTransactionActive) inconsistent();
  const reservation = await lockVoucherFundingReservation(manager, reservationId);
  const link = await manager.findOne(VoucherPaymentLink, { where: { reservationId } });
  if (!reservation || !link ||
      ![ReservationState.RESERVED, ReservationState.REDEEMED].includes(reservation.state) ||
      link.rail !== 'CASH' || link.reservationId !== reservation.id ||
      link.attemptId !== reservation.attemptId ||
      link.customerId !== reservation.customerId || link.scopeId !== reservation.scopeId ||
      !Array.isArray(link.allocationSnapshot) || link.allocationSnapshot.length === 0 ||
      voucherAllocationDigest(link.allocationSnapshot) !== link.allocationSha256 ||
      vnd(link.originalGrossVnd) - vnd(link.subsidyVnd) !== vnd(link.customerDueVnd)) inconsistent();
  const group = link.scopeKind === 'VISIT_GROUP'
    ? await manager.findOne(VisitGroupPayment, {
      where: { id: link.visitGroupPaymentId }, lock: { mode: 'pessimistic_read' },
    }) : null;
  if (link.scopeKind === 'VISIT_GROUP' &&
      (!group || group.visitGroupId !== link.scopeId || group.rail !== 'cash' ||
        group.status !== 'verified' || vnd(group.amount) !== vnd(link.customerDueVnd) ||
        !Array.isArray(group.allocations) || group.allocations.length !== link.allocationSnapshot.length)) inconsistent();
  if (link.scopeKind === 'SOLO' && (!link.cashSettlementId || link.visitGroupPaymentId)) inconsistent();

  const sources: { invoiceId: string; technicianId: string; subsidyVnd: number }[] = [];
  let grossTotal = 0;
  let subsidyTotal = 0;
  let dueTotal = 0;
  const seen = new Set<string>();
  for (const allocation of link.allocationSnapshot) {
    if (!allocation || !allocation.invoiceId || seen.has(allocation.invoiceId) ||
        vnd(allocation.originalGrossVnd) - vnd(allocation.subsidyVnd) !== vnd(allocation.customerDueVnd) ||
        vnd(allocation.subsidyVnd) > vnd(allocation.eligibleBaseVnd)) inconsistent();
    seen.add(allocation.invoiceId);
    const invoice = await manager.findOne(Invoice, {
      where: { id: allocation.invoiceId }, lock: { mode: 'pessimistic_read' },
    });
    const cash = await manager.findOne(CashSettlement, {
      where: link.scopeKind === 'SOLO'
        ? { id: link.cashSettlementId } : { serviceOrderId: invoice?.serviceOrderId },
      lock: { mode: 'pessimistic_read' },
    });
    const groupAllocation = group?.allocations.find(item => item.invoiceId === allocation.invoiceId);
    if (!invoice || !cash || invoice.paymentStatus !== PaymentStatus.PAID ||
        vnd(invoice.grandTotal) !== allocation.originalGrossVnd ||
        vnd(invoice.commissionAmount) !== allocation.commissionAmountVnd ||
        Number(invoice.commissionRateSnapshot) !== allocation.commissionRateSnapshot ||
        vnd(invoice.commissionAmount) + vnd(invoice.fixHomePartsTotal) +
          vnd(invoice.shippingFee) !== allocation.originalPlatformDueVnd ||
        allocation.originalGrossVnd - allocation.originalPlatformDueVnd !==
          allocation.technicianEntitlementVnd ||
        !(invoice.paidAt instanceof Date) || !Number.isFinite(+invoice.paidAt) ||
        +invoice.paidAt !== +cash.confirmedAt ||
        cash.serviceOrderId !== invoice.serviceOrderId ||
        (link.scopeKind === 'SOLO' && invoice.serviceOrderId !== link.scopeId) ||
        (link.scopeKind === 'VISIT_GROUP' &&
          (!groupAllocation || groupAllocation.serviceOrderId !== invoice.serviceOrderId ||
            vnd(groupAllocation.amount) !== allocation.customerDueVnd ||
            cash.declaredByTechnicianId !== group.requestedByUserId)) ||
        cash.status !== CashSettlementStatus.CONFIRMED ||
        cash.confirmedByCustomerId !== link.customerId ||
        !cash.declaredByTechnicianId ||
        vnd(cash.declaredAmount) !== allocation.customerDueVnd ||
        vnd(cash.confirmedAmount) !== allocation.customerDueVnd ||
        !(cash.confirmedAt instanceof Date) ||
        +cash.confirmedAt < +reservation.reservedAt ||
        +cash.confirmedAt >= +reservation.expiresAt) inconsistent();
    grossTotal += allocation.originalGrossVnd;
    subsidyTotal += allocation.subsidyVnd;
    dueTotal += allocation.customerDueVnd;
    sources.push({ invoiceId: invoice.id, technicianId: cash.declaredByTechnicianId,
      subsidyVnd: allocation.subsidyVnd });
  }
  if (![grossTotal, subsidyTotal, dueTotal].every(Number.isSafeInteger) ||
      grossTotal !== vnd(link.originalGrossVnd) || subsidyTotal !== vnd(link.subsidyVnd) ||
      dueTotal !== vnd(link.customerDueVnd)) inconsistent();

  let creditedVnd = 0;
  for (const source of sources) {
    if (source.subsidyVnd === 0) continue;
    const committed = await manager.findOne(VoucherFundingEntry, {
      where: { linkId: link.id, invoiceId: source.invoiceId, kind: 'SUBSIDY_COMMITTED' },
    });
    const credited = await manager.findOne(VoucherFundingEntry, {
      where: { linkId: link.id, invoiceId: source.invoiceId, kind: 'CASH_TECH_CREDIT' },
    });
    if (committed || credited) {
      if (!committed || !credited || vnd(committed.amountVnd) !== source.subsidyVnd ||
          vnd(credited.amountVnd) !== source.subsidyVnd || !credited.walletTransactionId) inconsistent();
      continue;
    }
    const wallet = await walletService.getOrCreateWallet(source.technicianId, manager);
    if (!wallet || wallet.technicianId !== source.technicianId) inconsistent();
    const key = `VOUCHER_CASH_CREDIT:${link.id}:${source.invoiceId}`;
    const { transaction } = await walletService.mutateBalance({
      walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT,
      // Cash platform fees may already have made the wallet negative. This is
      // a company credit, so it must also reduce an outstanding technician debt.
      amount: source.subsidyVnd, debit: false, allowNegative: true,
      referenceType: 'VOUCHER_FUNDING', referenceId: link.id,
      idempotencyKey: key, manager,
    });
    if (!transaction || transaction.walletId !== wallet.id ||
        transaction.type !== WalletTransactionType.ADJUSTMENT ||
        vnd(transaction.amount) !== source.subsidyVnd ||
        transaction.referenceType !== 'VOUCHER_FUNDING' ||
        transaction.referenceId !== link.id || transaction.idempotencyKey !== key) inconsistent();
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: source.invoiceId, kind: 'SUBSIDY_COMMITTED',
      amountVnd: source.subsidyVnd, idempotencyKey: `VOUCHER_SUBSIDY:${link.id}:${source.invoiceId}`,
      providerReference: null, providerPaidAt: null, evidenceSha256: link.allocationSha256,
      walletTransactionId: null, customerWalletTransactionId: null, refundSourceId: null,
    }));
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: source.invoiceId, kind: 'CASH_TECH_CREDIT',
      amountVnd: source.subsidyVnd, idempotencyKey: key,
      providerReference: null, providerPaidAt: null, evidenceSha256: link.allocationSha256,
      walletTransactionId: transaction.id, customerWalletTransactionId: null, refundSourceId: null,
    }));
    creditedVnd += source.subsidyVnd;
  }
  return creditedVnd;
}

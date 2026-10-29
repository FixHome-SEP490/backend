import { voucherAllocationDigest } from './voucher-allocation-digest';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CashSettlementStatus, PaymentAttemptStatus, PaymentMode, PaymentPurpose, PaymentStatus, WalletTransactionType } from '../../shared/enums';
import { CustomerWallet } from '../customer-wallet/entities/customer-wallet.entity';
import { CustomerWalletTransaction } from '../customer-wallet/entities/customer-wallet-transaction.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../finance/entities/payment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { ReservationState } from './voucher.types';
import { lockVoucherFundingReservation } from './voucher-funding-lock';
import type { SettlementFacts } from './voucher.types';

function inconsistent(): never {
  throw new ConflictException('Bằng chứng quyết toán ưu đãi không nhất quán.');
}

function amount(value: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || value === '' ||
      !Number.isSafeInteger(number) || number < 0) inconsistent();
  return number;
}

function signedBalance(value: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || value === '' ||
      !Number.isSafeInteger(number)) inconsistent();
  return number;
}

function date(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(+value);
}

async function verifyWalletDebit(
  manager: EntityManager, reference: string | null | undefined,
  customerId: string, scopeKind: string, sourceId: string,
  due: number,
): Promise<void> {
  if (typeof reference !== 'string' || !/^WALLET_TX:[0-9a-f-]{36}$/i.test(reference)) inconsistent();
  const transaction = await manager.findOne(CustomerWalletTransaction, {
    where: { id: reference.slice('WALLET_TX:'.length) }, lock: { mode: 'pessimistic_read' },
  });
  const wallet = transaction && await manager.findOne(CustomerWallet, {
    where: { id: transaction.walletId }, lock: { mode: 'pessimistic_read' },
  });
  if (!transaction || !wallet || wallet.userId !== customerId ||
      transaction.type !== 'invoice_payment' || amount(transaction.amount) !== due ||
      transaction.referenceType !== (scopeKind === 'SOLO' ? 'INVOICE' : 'VISIT_GROUP') ||
      transaction.referenceId !== sourceId ||
      amount(transaction.balanceBefore) - amount(transaction.balanceAfter) !== due) inconsistent();
}

/** Read-only authoritative evidence; no request amount or caller verdict is used. */
async function inspectVoucherSettlementFacts(
  manager: EntityManager, settlementId: string, requireJournal: boolean,
): Promise<SettlementFacts> {
  const linkWhere = [
    { paymentId: settlementId }, { cashSettlementId: settlementId },
    { visitGroupPaymentId: settlementId }, { id: settlementId, rail: 'ZERO' as const },
  ];
  const referenceLink = await manager.findOne(VoucherPaymentLink, { where: linkWhere });
  if (!referenceLink) inconsistent();
  const reservation = await lockVoucherFundingReservation(manager, referenceLink.reservationId);
  const link = await manager.findOne(VoucherPaymentLink, {
    where: linkWhere, lock: { mode: 'pessimistic_read' },
  });
  if (!link || link.id !== referenceLink.id || !['SOLO', 'VISIT_GROUP'].includes(link.scopeKind) ||
      !['WALLET', 'VNPAY', 'CASH', 'ZERO'].includes(link.rail) ||
      (link.paymentId ?? link.cashSettlementId ?? link.visitGroupPaymentId ?? link.id) !== settlementId ||
      !Array.isArray(link.allocationSnapshot) || link.allocationSnapshot.length === 0 ||
      voucherAllocationDigest(link.allocationSnapshot) !== link.allocationSha256 ||
      amount(link.originalGrossVnd) - amount(link.subsidyVnd) !== amount(link.customerDueVnd)) inconsistent();
  if (!reservation || reservation.id !== link.reservationId ||
      reservation.attemptId !== link.attemptId || reservation.customerId !== link.customerId ||
      reservation.scopeId !== link.scopeId ||
      !([ReservationState.RESERVED, ReservationState.REDEEMED] as string[]).includes(reservation.state) ||
      (reservation.state === ReservationState.REDEEMED && reservation.settlementId !== settlementId) ||
      !reservation.checkoutSnapshot?.snapshotId ||
      amount(reservation.checkoutSnapshot.eligibleSubtotalVnd) !== amount(link.eligibleBaseVnd)) inconsistent();
  if (link.scopeKind === 'VISIT_GROUP') {
    const visit = await manager.findOne(VisitGroup, {
      where: { id: link.scopeId }, lock: { mode: 'pessimistic_read' },
    });
    if (!visit || visit.customerId !== link.customerId) inconsistent();
  }
  const entries = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  if (entries.some(entry => entry.kind === 'QUARANTINED' || entry.kind === 'PROVIDER_FAILED') ||
      (link.rail !== 'VNPAY' && entries.some(entry => entry.kind.startsWith('PROVIDER_')))) inconsistent();
  let settledAt: Date | null = null;
  let requestedAt: Date | null = null;
  let group: VisitGroupPayment | null = null;
  const cashTechnicians = new Map<string, string>();
  if (link.scopeKind === 'VISIT_GROUP' && link.rail !== 'ZERO') {
    group = await manager.findOne(VisitGroupPayment, {
      where: { id: link.visitGroupPaymentId }, lock: { mode: 'pessimistic_read' },
    });
    if (!group || group.id !== settlementId || group.visitGroupId !== link.scopeId ||
        group.rail !== link.rail.toLowerCase() || group.status !== 'verified' ||
        amount(group.amount) !== amount(link.customerDueVnd) ||
        (link.rail !== 'CASH' && group.requestedByUserId !== link.customerId) ||
        !Array.isArray(group.allocations) || group.allocations.length !== link.allocationSnapshot.length ||
        !date(group.verifiedAt) || !date(group.requestedAt)) inconsistent();
    settledAt = group.verifiedAt;
    requestedAt = group.requestedAt;
    if (link.rail === 'VNPAY' && (group.idempotencyKey !== link.providerTxnRef ||
        +group.requestedAt !== +link.providerInitiatedAt)) inconsistent();
    if (link.rail === 'WALLET') {
      await verifyWalletDebit(manager, group.providerReference, link.customerId,
        'VISIT_GROUP', link.scopeId, amount(link.customerDueVnd));
    }
  } else if (link.scopeKind === 'SOLO' && ['WALLET', 'VNPAY'].includes(link.rail)) {
    const payment = await manager.findOne(Payment, {
      where: { id: link.paymentId }, lock: { mode: 'pessimistic_read' },
    });
    if (!payment || link.allocationSnapshot.length !== 1 || payment.id !== settlementId ||
        payment.purpose !== PaymentPurpose.INVOICE || payment.mode !== PaymentMode.LIVE ||
        payment.currency !== 'VND' || payment.status !== PaymentAttemptStatus.VERIFIED ||
        payment.provider !== link.rail.toLowerCase() ||
        payment.requestedByUserId !== link.customerId ||
        amount(payment.amount) !== amount(link.customerDueVnd) ||
        payment.invoiceId !== link.allocationSnapshot[0]?.invoiceId ||
        !date(payment.verifiedAt) || !date(payment.requestedAt)) inconsistent();
    settledAt = payment.verifiedAt;
    requestedAt = payment.requestedAt;
    if (link.rail === 'VNPAY' && (payment.idempotencyKey !== link.providerTxnRef ||
        +payment.requestedAt !== +link.providerInitiatedAt)) inconsistent();
    if (link.rail === 'WALLET') {
      await verifyWalletDebit(manager, payment.providerReference, link.customerId,
        'SOLO', payment.invoiceId, amount(link.customerDueVnd));
    }
  } else if (link.scopeKind === 'SOLO' && link.rail === 'CASH') {
    const cash = await manager.findOne(CashSettlement, {
      where: { id: link.cashSettlementId }, lock: { mode: 'pessimistic_read' },
    });
    if (!cash || cash.id !== settlementId || cash.serviceOrderId !== link.scopeId ||
        cash.status !== CashSettlementStatus.CONFIRMED ||
        cash.confirmedByCustomerId !== link.customerId ||
        amount(cash.confirmedAmount) !== amount(link.customerDueVnd) ||
        amount(cash.declaredAmount) !== amount(link.customerDueVnd) ||
        !cash.declaredByTechnicianId || !date(cash.confirmedAt) || !date(cash.declaredAt)) inconsistent();
    settledAt = cash.confirmedAt;
    requestedAt = cash.declaredAt;
    cashTechnicians.set(link.allocationSnapshot[0].invoiceId, cash.declaredByTechnicianId);
  } else if (link.rail !== 'ZERO' || link.customerDueVnd !== 0 ||
      link.paymentId || link.cashSettlementId || link.visitGroupPaymentId) inconsistent();

  let gross = 0;
  let eligible = 0;
  let subsidy = 0;
  let due = 0;
  const seen = new Set<string>();
  for (const allocation of link.allocationSnapshot) {
    if (!allocation || !allocation.invoiceId || seen.has(allocation.invoiceId) ||
        amount(allocation.originalGrossVnd) - amount(allocation.subsidyVnd) !== amount(allocation.customerDueVnd) ||
        amount(allocation.subsidyVnd) > amount(allocation.eligibleBaseVnd)) inconsistent();
    seen.add(allocation.invoiceId);
    const invoice = await manager.findOne(Invoice, {
      where: { id: allocation.invoiceId }, lock: { mode: 'pessimistic_read' },
    });
    const order = invoice && await manager.findOne(ServiceOrder, {
      where: { id: invoice.serviceOrderId }, lock: { mode: 'pessimistic_read' },
    });
    const booking = order && await manager.findOne(Booking, {
      where: { id: order.bookingId }, lock: { mode: 'pessimistic_read' },
    });
    if (!invoice || invoice.id !== allocation.invoiceId ||
        !order || order.id !== invoice.serviceOrderId || !booking ||
        booking.customerId !== link.customerId ||
        (link.scopeKind === 'VISIT_GROUP'
          ? booking.visitGroupId !== link.scopeId : !!booking.visitGroupId) ||
        invoice.paymentStatus !== PaymentStatus.PAID || !date(invoice.paidAt) ||
        amount(invoice.grandTotal) !== allocation.originalGrossVnd ||
        amount(invoice.commissionAmount) !== allocation.commissionAmountVnd ||
        Number(invoice.commissionRateSnapshot) !== allocation.commissionRateSnapshot ||
        amount(invoice.commissionAmount) + amount(invoice.fixHomePartsTotal) + amount(invoice.shippingFee) !== allocation.originalPlatformDueVnd ||
        allocation.originalGrossVnd - allocation.originalPlatformDueVnd !== allocation.technicianEntitlementVnd ||
        (link.rail !== 'ZERO' && +invoice.paidAt !== +settledAt) ||
        (link.scopeKind === 'SOLO' && invoice.serviceOrderId !== link.scopeId)) inconsistent();
    if (group) {
      const split = group.allocations.filter(item => item.invoiceId === invoice.id);
      if (split.length !== 1 || split[0].serviceOrderId !== invoice.serviceOrderId ||
          amount(split[0].amount) !== allocation.customerDueVnd) inconsistent();
      if (link.rail === 'CASH') {
        const cash = await manager.findOne(CashSettlement, {
          where: { serviceOrderId: invoice.serviceOrderId }, lock: { mode: 'pessimistic_read' },
        });
        if (!cash || cash.status !== CashSettlementStatus.CONFIRMED ||
            cash.confirmedByCustomerId !== link.customerId ||
            cash.declaredByTechnicianId !== group.requestedByUserId ||
            amount(cash.declaredAmount) !== allocation.customerDueVnd ||
            amount(cash.confirmedAmount) !== allocation.customerDueVnd ||
            !date(cash.confirmedAt) || +cash.confirmedAt !== +settledAt) inconsistent();
        cashTechnicians.set(invoice.id, cash.declaredByTechnicianId);
      } else {
        const child = await manager.findOne(Payment, {
          where: { invoiceId: invoice.id, status: PaymentAttemptStatus.VERIFIED },
          lock: { mode: 'pessimistic_read' },
        });
        if (!child || child.invoiceId !== invoice.id ||
            child.purpose !== PaymentPurpose.INVOICE || child.mode !== PaymentMode.LIVE ||
            child.currency !== 'VND' || child.provider !== link.rail.toLowerCase() ||
            child.requestedByUserId !== link.customerId ||
            amount(child.amount) !== allocation.customerDueVnd ||
            !date(child.verifiedAt) || +child.verifiedAt !== +settledAt) inconsistent();
      }
    }
    const committed = entries.filter(entry => entry.kind === 'SUBSIDY_COMMITTED' && entry.invoiceId === invoice.id);
    if ((requireJournal && allocation.subsidyVnd > 0 && committed.length !== 1) ||
        committed.length > 1 || (allocation.subsidyVnd === 0 && committed.length !== 0) ||
        (committed.length === 1 &&
          (amount(committed[0].amountVnd) !== allocation.subsidyVnd ||
            committed[0].evidenceSha256 !== link.allocationSha256))) inconsistent();
    if (link.rail === 'CASH' && allocation.subsidyVnd > 0) {
      const credit = entries.filter(entry => entry.kind === 'CASH_TECH_CREDIT' && entry.invoiceId === invoice.id);
      if (credit.length !== 1 || amount(credit[0].amountVnd) !== allocation.subsidyVnd ||
          !credit[0].walletTransactionId || credit[0].evidenceSha256 !== link.allocationSha256) inconsistent();
      const transaction = await manager.findOne(WalletTransaction, {
        where: { id: credit[0].walletTransactionId }, lock: { mode: 'pessimistic_read' },
      });
      const wallet = transaction && await manager.findOne(Wallet, {
        where: { id: transaction.walletId }, lock: { mode: 'pessimistic_read' },
      });
      if (!transaction || !wallet || !cashTechnicians.get(invoice.id) ||
          wallet.technicianId !== cashTechnicians.get(invoice.id) ||
          transaction.type !== WalletTransactionType.ADJUSTMENT ||
          amount(transaction.amount) !== allocation.subsidyVnd ||
          signedBalance(transaction.balanceAfter) - signedBalance(transaction.balanceBefore) !== allocation.subsidyVnd ||
          transaction.referenceType !== 'VOUCHER_FUNDING' ||
          transaction.referenceId !== link.id ||
          transaction.idempotencyKey !== `VOUCHER_CASH_CREDIT:${link.id}:${invoice.id}`) inconsistent();
    }
    if (link.rail === 'ZERO') {
      if (!date(link.createdAt) || +invoice.paidAt < +link.createdAt) inconsistent();
      settledAt = !settledAt || +invoice.paidAt > +settledAt ? invoice.paidAt : settledAt;
    }
    gross += allocation.originalGrossVnd;
    eligible += allocation.eligibleBaseVnd;
    subsidy += allocation.subsidyVnd;
    due += allocation.customerDueVnd;
  }
  if (entries.some(entry =>
      (entry.kind === 'SUBSIDY_COMMITTED' || entry.kind === 'CASH_TECH_CREDIT') &&
      (!entry.invoiceId || !seen.has(entry.invoiceId) ||
        (entry.kind === 'CASH_TECH_CREDIT' && link.rail !== 'CASH')))) inconsistent();
  if (![gross, eligible, subsidy, due].every(Number.isSafeInteger) ||
      gross !== amount(link.originalGrossVnd) || eligible !== amount(link.eligibleBaseVnd) ||
      subsidy !== amount(link.subsidyVnd) || due !== amount(link.customerDueVnd) ||
      !date(settledAt) || +settledAt < +reservation.reservedAt ||
      (link.rail !== 'ZERO' && (!date(requestedAt) ||
        +requestedAt < +reservation.reservedAt || +requestedAt >= +reservation.expiresAt ||
        +requestedAt > +settledAt))) inconsistent();
  if (link.rail === 'VNPAY') {
    const pending = entries.filter(entry => entry.kind === 'PROVIDER_PENDING');
    const paid = entries.filter(entry => entry.kind === 'PROVIDER_PAID');
    const providerReference = group?.providerReference ??
      (await manager.findOne(Payment, { where: { id: link.paymentId } }))?.providerReference;
    if (!date(link.providerInitiatedAt) ||
        +link.providerInitiatedAt < +reservation.reservedAt ||
        +link.providerInitiatedAt >= +reservation.expiresAt ||
        pending.length !== 1 || pending[0].amountVnd !== 0 ||
        pending[0].evidenceSha256 !== link.allocationSha256 ||
        paid.length !== 1 || paid[0].amountVnd !== 0 ||
        !paid[0].evidenceSha256 || !paid[0].providerReference ||
        providerReference !== paid[0].providerReference ||
        !date(paid[0].providerPaidAt) ||
        +paid[0].providerPaidAt < +link.providerInitiatedAt ||
        +paid[0].providerPaidAt >= +reservation.expiresAt ||
        +paid[0].providerPaidAt > +settledAt) inconsistent();
  } else if (+settledAt >= +reservation.expiresAt) inconsistent();
  return { settlementId, reservationId: reservation.id, customerId: reservation.customerId,
    scopeId: reservation.scopeId, snapshotId: reservation.checkoutSnapshot.snapshotId,
    status: 'SETTLED', settledAt };
}

export async function loadVoucherSettlementFacts(
  manager: EntityManager, settlementId: string,
): Promise<SettlementFacts> {
  return inspectVoucherSettlementFacts(manager, settlementId, true);
}

/**
 * Called by a Finance rail in the SAME transaction that verified the source
 * payment and marked its invoices PAID. The complete source proof is checked
 * before any company funding row is written. It never changes Invoice amounts.
 */
export async function commitVerifiedVoucherFunding(
  manager: EntityManager, settlementId: string,
): Promise<SettlementFacts> {
  if (!manager.queryRunner?.isTransactionActive) inconsistent();
  const proof = await inspectVoucherSettlementFacts(manager, settlementId, false);
  const link = await manager.findOne(VoucherPaymentLink, {
    where: [
      { paymentId: settlementId }, { visitGroupPaymentId: settlementId },
      { id: settlementId, rail: 'ZERO' },
    ], lock: { mode: 'pessimistic_read' },
  });
  if (!link || link.rail === 'CASH' || link.reservationId !== proof.reservationId ||
      !Array.isArray(link.allocationSnapshot)) inconsistent();
  const existing = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  for (const allocation of link.allocationSnapshot) {
    if (allocation.subsidyVnd === 0) continue;
    const recorded = existing.filter(entry => entry.kind === 'SUBSIDY_COMMITTED' &&
      entry.invoiceId === allocation.invoiceId);
    if (recorded.length > 1 || (recorded.length === 1 &&
        (amount(recorded[0].amountVnd) !== allocation.subsidyVnd ||
          recorded[0].evidenceSha256 !== link.allocationSha256))) inconsistent();
    if (recorded.length === 1) continue;
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: link.id, invoiceId: allocation.invoiceId,
      kind: 'SUBSIDY_COMMITTED', amountVnd: allocation.subsidyVnd,
      idempotencyKey: `VOUCHER_SUBSIDY:${link.id}:${allocation.invoiceId}`,
      providerReference: null, providerPaidAt: null,
      evidenceSha256: link.allocationSha256,
      walletTransactionId: null, customerWalletTransactionId: null, refundSourceId: null,
    }));
  }
  return loadVoucherSettlementFacts(manager, settlementId);
}

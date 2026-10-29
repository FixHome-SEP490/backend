import { voucherAllocationDigest } from './voucher-allocation-digest';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CashSettlementStatus, PaymentAttemptStatus, PaymentMode, PaymentPurpose } from '../../shared/enums';
import { Payment } from '../finance/entities/payment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VoucherFundingEntry, VoucherPaymentLink, type VoucherFundingRail, type VoucherFundingScopeKind } from './entities/voucher-funding.entity';
import { VoucherClaim, VoucherReservation } from './entities/voucher.entity';
import { allocateVoucherFunding } from './voucher-funding-allocation';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';
import { ReservationState } from './voucher.types';
import { lockVoucherFundingReservation } from './voucher-funding-lock';

function unavailable(): never {
  throw new ConflictException('Không thể liên kết thanh toán ưu đãi với dữ liệu đã chốt.');
}

function amount(value: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || value === '' ||
      !Number.isSafeInteger(number) || number < 0) unavailable();
  return number;
}

function withinHold(time: unknown, reservation: VoucherReservation, now: Date): time is Date {
  return time instanceof Date && Number.isFinite(+time) &&
    +time >= +reservation.reservedAt && +time < +reservation.expiresAt && +time <= +now;
}

/**
 * F4 persistence boundary for an attempt that a future Finance transaction has
 * already created. This function must run in that SAME database transaction,
 * before external collection. It takes IDs only, reloads all money from frozen
 * server sources under locks, and never accepts client amounts. No payment rail
 * calls it yet; voucher Apply remains fail closed until all rails are complete.
 */
export async function bindVoucherPaymentLink(
  manager: EntityManager,
  reservationId: string,
  rail: VoucherFundingRail,
  sourceId?: string,
): Promise<VoucherPaymentLink> {
  if (!manager.queryRunner?.isTransactionActive) unavailable();
  const reservation = await lockVoucherFundingReservation(manager, reservationId);
  if (!reservation || ![ReservationState.RESERVED, ReservationState.REDEEMED].includes(reservation.state)) unavailable();
  const existing = await manager.findOne(VoucherPaymentLink, { where: { reservationId: reservation.id } });
  if (existing) {
    const boundSource = existing.paymentId ?? existing.cashSettlementId ?? existing.visitGroupPaymentId ?? undefined;
    const hash = voucherAllocationDigest(existing.allocationSnapshot);
    if (existing.reservationId !== reservation.id || existing.attemptId !== reservation.attemptId ||
        existing.customerId !== reservation.customerId || existing.scopeId !== reservation.scopeId ||
        existing.rail !== rail || boundSource !== sourceId ||
        existing.allocationSha256 !== hash ||
        (rail === 'ZERO') !== (sourceId === undefined)) unavailable();
    if (rail === 'VNPAY') {
      const pending = await manager.findOne(VoucherFundingEntry, {
        where: { linkId: existing.id, kind: 'PROVIDER_PENDING' },
      });
      if (!pending || pending.evidenceSha256 !== hash || pending.amountVnd !== 0) unavailable();
    }
    return existing;
  }
  const now = new Date((await manager.query('SELECT clock_timestamp() AS now'))[0]?.now);
  if (!Number.isFinite(+now) || reservation.state !== ReservationState.RESERVED ||
      +now >= +reservation.expiresAt || +now < +reservation.reservedAt) unavailable();
  const claim = await manager.findOneBy(VoucherClaim, { id: reservation.claimId, customerId: reservation.customerId });
  if (!claim || claim.redeemedAt) unavailable();
  const group = await manager.findOneBy(VisitGroup, { id: reservation.scopeId });
  if (group && group.customerId !== reservation.customerId) unavailable();
  const scopeKind: VoucherFundingScopeKind = group ? 'VISIT_GROUP' : 'SOLO';
  const facts = await loadVoucherPreviewInvoices(manager, reservation.customerId, reservation.scopeId, true);
  if (!facts.services.length || facts.services.some(service =>
      (claim.policySnapshot.serviceIds.length > 0 && !claim.policySnapshot.serviceIds.includes(service.serviceId)) ||
      (claim.policySnapshot.categoryIds.length > 0 && !claim.policySnapshot.categoryIds.includes(service.categoryId)))) unavailable();
  const funding = allocateVoucherFunding({ policy: reservation.policySnapshot, invoices: facts.invoices });
  if (reservation.checkoutSnapshot.eligibleSubtotalVnd !== funding.total.eligibleBaseVnd) unavailable();
  const due = funding.total.customerDueVnd;
  if ((rail === 'ZERO') !== (due === 0) || (rail === 'ZERO') !== (sourceId === undefined)) unavailable();
  let paymentId: string | null = null;
  let cashSettlementId: string | null = null;
  let visitGroupPaymentId: string | null = null;
  let providerTxnRef: string | null = null;
  let providerInitiatedAt: Date | null = null;

  if (scopeKind === 'SOLO' && rail === 'CASH') {
    const cash = await manager.findOne(CashSettlement, {
      where: { id: sourceId }, lock: { mode: 'pessimistic_write' },
    });
    if (!cash || cash.serviceOrderId !== reservation.scopeId ||
        cash.status !== CashSettlementStatus.PENDING_CONFIRMATION ||
        amount(cash.declaredAmount) !== due || !withinHold(cash.declaredAt, reservation, now)) unavailable();
    cashSettlementId = cash.id;
  } else if (scopeKind === 'SOLO' && rail !== 'ZERO') {
    const payment = await manager.findOne(Payment, {
      where: { id: sourceId }, lock: { mode: 'pessimistic_write' },
    });
    if (!payment || funding.invoices.length !== 1 ||
        payment.invoiceId !== funding.invoices[0].invoiceId ||
        payment.purpose !== PaymentPurpose.INVOICE ||
        payment.mode !== PaymentMode.LIVE ||
        amount(payment.amount) !== due ||
        payment.requestedByUserId !== reservation.customerId ||
        payment.provider !== rail.toLowerCase() ||
        payment.status !== (rail === 'VNPAY' ? PaymentAttemptStatus.PENDING : PaymentAttemptStatus.VERIFIED) ||
        !withinHold(payment.requestedAt, reservation, now)) unavailable();
    paymentId = payment.id;
    if (rail === 'VNPAY') {
      providerTxnRef = payment.idempotencyKey;
      providerInitiatedAt = payment.requestedAt;
    }
  } else if (scopeKind === 'VISIT_GROUP' && rail !== 'ZERO') {
    const payment = await manager.findOne(VisitGroupPayment, {
      where: { id: sourceId }, lock: { mode: 'pessimistic_write' },
    });
    const expectedStatus = rail === 'VNPAY' ? 'pending' : rail === 'CASH' ? 'pending_confirmation' : 'verified';
    if (!payment || payment.visitGroupId !== reservation.scopeId ||
        payment.rail !== rail.toLowerCase() || payment.status !== expectedStatus ||
        amount(payment.amount) !== due || !withinHold(payment.requestedAt, reservation, now) ||
        (rail !== 'CASH' && payment.requestedByUserId !== reservation.customerId) ||
        !Array.isArray(payment.allocations) || payment.allocations.length !== funding.invoices.length) unavailable();
    const dueByInvoice = new Map(funding.invoices.map(invoice => [invoice.invoiceId, invoice.customerDueVnd]));
    const seen = new Set<string>();
    for (const allocation of payment.allocations) {
      const invoice = await manager.findOneBy(Invoice, { id: allocation.invoiceId });
      if (!invoice || seen.has(allocation.invoiceId) ||
          invoice.serviceOrderId !== allocation.serviceOrderId ||
          dueByInvoice.get(allocation.invoiceId) !== amount(allocation.amount)) unavailable();
      seen.add(allocation.invoiceId);
    }
    visitGroupPaymentId = payment.id;
    if (rail === 'VNPAY') {
      providerTxnRef = payment.idempotencyKey;
      providerInitiatedAt = payment.requestedAt;
    }
  }
  if (rail === 'VNPAY' && (!providerTxnRef || providerTxnRef.length > 128)) unavailable();
  const snapshot = funding.invoices.map(invoice => ({ ...invoice }));
  const hash = voucherAllocationDigest(snapshot);
  const values = {
    reservationId: reservation.id, attemptId: reservation.attemptId,
    customerId: reservation.customerId, scopeId: reservation.scopeId, scopeKind, rail,
    paymentId, cashSettlementId, visitGroupPaymentId, providerTxnRef, providerInitiatedAt,
    originalGrossVnd: funding.total.originalGrossVnd,
    eligibleBaseVnd: funding.total.eligibleBaseVnd,
    subsidyVnd: funding.total.fixHomeDiscountSubsidyVnd,
    customerDueVnd: due, allocationSnapshot: snapshot, allocationSha256: hash,
  };
  const saved = await manager.save(VoucherPaymentLink, manager.create(VoucherPaymentLink, values));
  if (rail === 'VNPAY') {
    await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
      linkId: saved.id, invoiceId: null, kind: 'PROVIDER_PENDING', amountVnd: 0,
      idempotencyKey: `VOUCHER_PENDING:${reservation.id}`,
      providerReference: null, providerPaidAt: null, evidenceSha256: hash,
      walletTransactionId: null, customerWalletTransactionId: null, refundSourceId: null,
    }));
  }
  return saved;
}

import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PaymentAttemptStatus } from '../../shared/enums';
import { Payment } from '../finance/entities/payment.entity';
import { verifySignature } from '../finance/vnpay/vnpay.util';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from './entities/voucher-funding.entity';
import { ReservationState } from './voucher.types';
import { evaluateSignedVoucherVnpayCallback, type SignedVoucherVnpayResult } from './voucher-vnpay-evidence';
import { lockVoucherFundingReservation } from './voucher-funding-lock';

const QUARANTINE: SignedVoucherVnpayResult = Object.freeze({
  decision: 'QUARANTINE', providerReference: null, providerPaidAt: null,
});

/**
 * Persist authenticated provider evidence in the caller's transaction. The
 * reservation lock serializes duplicate IPNs and the append-only ledger makes
 * terminal outcomes durable. This does not mark any Payment or voucher paid.
 */
export async function recordSignedVoucherVnpayOutcome(
  manager: EntityManager,
  reservationId: string,
  query: Record<string, string>,
  merchantCode: string,
  hashSecret: string,
): Promise<SignedVoucherVnpayResult> {
  if (!query || typeof query !== 'object' || !verifySignature(query, hashSecret)) return QUARANTINE;
  if (!manager.queryRunner?.isTransactionActive) {
    throw new ConflictException('Chứng cứ VNPay cần giao dịch cơ sở dữ liệu.');
  }
  const reservation = await lockVoucherFundingReservation(manager, reservationId);
  const link = await manager.findOne(VoucherPaymentLink, {
    where: { reservationId }, lock: { mode: 'pessimistic_write' },
  });
  if (!reservation || !link || link.rail !== 'VNPAY' ||
      link.reservationId !== reservation.id || link.attemptId !== reservation.attemptId ||
      link.customerId !== reservation.customerId || link.scopeId !== reservation.scopeId ||
      !link.providerTxnRef || query.vnp_TxnRef !== link.providerTxnRef ||
      query.vnp_TmnCode !== merchantCode || !merchantCode) return QUARANTINE;
  const pending = await manager.findOne(VoucherFundingEntry, {
    where: { linkId: link.id, kind: 'PROVIDER_PENDING' },
  });
  if (!pending || pending.amountVnd !== 0 || pending.evidenceSha256 !== link.allocationSha256) {
    throw new ConflictException('Bằng chứng khởi tạo thanh toán ưu đãi không nhất quán.');
  }
  const observedAt = new Date((await manager.query('SELECT clock_timestamp() AS now'))[0]?.now);
  if (!Number.isFinite(+observedAt)) return QUARANTINE;
  const digest = createHash('sha256').update(JSON.stringify(
    Object.entries(query).filter(([key]) => key.startsWith('vnp_')).sort(([a], [b]) => a.localeCompare(b)),
  )).digest('hex');
  const entries = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  if (entries.some(entry => entry.kind === 'QUARANTINED')) return QUARANTINE;
  const evaluated = evaluateSignedVoucherVnpayCallback({
    attemptId: link.providerTxnRef,
    customerDueVnd: link.customerDueVnd,
    reservedAt: reservation.reservedAt,
    expiresAt: reservation.expiresAt,
    initiatedAt: link.providerInitiatedAt,
    merchantCode,
  }, query, hashSecret, observedAt);
  const result = reservation.state === ReservationState.RESERVED ||
    (reservation.state === ReservationState.REDEEMED && evaluated.decision === 'SETTLE')
    ? evaluated : QUARANTINE;
  const terminal = entries.find(entry => entry.kind === 'PROVIDER_PAID' || entry.kind === 'PROVIDER_FAILED');
  if (!terminal && result.decision === 'KEEP_PENDING') return result;
  if (terminal && terminal.evidenceSha256 === digest &&
      ((terminal.kind === 'PROVIDER_PAID' && result.decision === 'SETTLE') ||
       (terminal.kind === 'PROVIDER_FAILED' && result.decision === 'RELEASE'))) {
    return result;
  }
  const decision = terminal ? 'QUARANTINE' : result.decision;
  const kind = decision === 'SETTLE' ? 'PROVIDER_PAID' :
    decision === 'RELEASE' ? 'PROVIDER_FAILED' : 'QUARANTINED';
  await manager.save(VoucherFundingEntry, manager.create(VoucherFundingEntry, {
    linkId: link.id, invoiceId: null, kind, amountVnd: 0,
    idempotencyKey: `VOUCHER_VNPAY:${link.id}:${digest}`,
    providerReference: decision === 'RELEASE' ? null : evaluated.providerReference,
    providerPaidAt: decision === 'RELEASE' ? null : evaluated.providerPaidAt,
    evidenceSha256: digest,
    walletTransactionId: null, customerWalletTransactionId: null, refundSourceId: null,
  }));
  return decision === 'QUARANTINE' ? { decision, providerReference: evaluated.providerReference,
    providerPaidAt: evaluated.providerPaidAt } : result;
}

/** Unknown, in-flight, paid, or contradictory evidence always keeps the slot. */
export async function canReleaseVoucherReservation(
  manager: EntityManager,
  reservationId: string,
): Promise<boolean> {
  const reservation = await lockVoucherFundingReservation(manager, reservationId);
  if (!reservation || reservation.state !== ReservationState.RESERVED) return false;
  const link = await manager.findOne(VoucherPaymentLink, { where: { reservationId } });
  if (!link || link.rail !== 'VNPAY' || link.reservationId !== reservation.id ||
      link.attemptId !== reservation.attemptId || link.customerId !== reservation.customerId ||
      link.scopeId !== reservation.scopeId || !link.providerTxnRef ||
      !Number.isSafeInteger(link.customerDueVnd) || link.customerDueVnd <= 0) return false;
  const entries = await manager.find(VoucherFundingEntry, { where: { linkId: link.id } });
  const pending = entries.filter(entry => entry.kind === 'PROVIDER_PENDING');
  const failed = entries.filter(entry => entry.kind === 'PROVIDER_FAILED');
  if (pending.length !== 1 || pending[0].amountVnd !== 0 ||
      pending[0].evidenceSha256 !== link.allocationSha256 ||
      failed.length !== 1 || failed[0].amountVnd !== 0 ||
      !failed[0].evidenceSha256 ||
      entries.some(entry => entry.kind === 'PROVIDER_PAID' || entry.kind === 'QUARANTINED')) return false;
  if (link.paymentId && !link.visitGroupPaymentId) {
    const payment = await manager.findOne(Payment, {
      where: { id: link.paymentId }, lock: { mode: 'pessimistic_read' },
    });
    return !!payment && payment.provider === 'vnpay' &&
      payment.requestedByUserId === reservation.customerId &&
      payment.idempotencyKey === link.providerTxnRef &&
      Number(payment.amount) === link.customerDueVnd &&
      [PaymentAttemptStatus.FAILED, PaymentAttemptStatus.CANCELLED].includes(payment.status);
  }
  if (link.visitGroupPaymentId && !link.paymentId) {
    const payment = await manager.findOne(VisitGroupPayment, {
      where: { id: link.visitGroupPaymentId }, lock: { mode: 'pessimistic_read' },
    });
    return !!payment && payment.rail === 'vnpay' &&
      payment.visitGroupId === reservation.scopeId &&
      payment.requestedByUserId === reservation.customerId &&
      payment.idempotencyKey === link.providerTxnRef &&
      Number(payment.amount) === link.customerDueVnd &&
      ['failed', 'cancelled'].includes(payment.status);
  }
  return false;
}

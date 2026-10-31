import { EntityManager, In } from 'typeorm';
import { PaymentStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { CashPaymentIntent } from '../finance/entities/cash-payment-intent.entity';
import { Payment } from '../finance/entities/payment.entity';
import { PartCustody } from '../part-requests/entities/part-custody.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { VoucherClaim, VoucherReservation } from '../vouchers/entities/voucher.entity';
import { CashSettlement } from './entities/cash-settlement.entity';
import { Invoice } from './entities/invoice.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { hasOnsiteInterruption, verifiedOnsiteInterruption } from './onsite-interruption';

/** Informational only. STOP is not proof of genuine failed work, a zero receivable or refund. */
export async function loadOnsiteStopFinance(manager: EntityManager, order: ServiceOrder, booking: Booking) {
  if (!await hasOnsiteInterruption(manager, order.id)) return null;
  const proof = await verifiedOnsiteInterruption(manager, order, booking);
  const reasonCodes = ['FAILED_WORK_NOT_PROVEN'];
  if (!proof?.workStopped) reasonCodes.push('STOP_PROOF_INVALID_OR_NOT_FINALIZED');
  if (order.paymentStatus !== PaymentStatus.UNPAID) reasonCodes.push('ORDER_PAYMENT_REQUIRES_REVIEW');
  const scopeIds = [order.id, ...(booking.visitGroupId ? [booking.visitGroupId] : [])];
  const evidence = {
    invoices: [] as { id: string; paymentStatus: string }[],
    payments: [] as { id: string; status: string }[],
    cashSettlements: [] as { id: string; status: string }[],
    cashIntents: [] as { id: string; status: string }[],
    visitPayments: [] as { id: string; status: string }[],
    voucherReservations: [] as { id: string; state: string }[],
    voucherClaims: [] as { id: string }[], voucherLinks: [] as { id: string }[],
    voucherFunding: [] as { id: string; kind: string }[],
    partRequests: [] as { id: string }[], partCustodies: [] as { id: string }[],
  };
  // Allowlist IDs/states only: never provider refs, customer/technician IDs, notes or tokens.
  const ids = (rows: { id: string }[]) => rows.map(row => ({ id: row.id }));
  const states = (rows: { id: string; status: string }[]) => rows.map(row => ({ id: row.id, status: row.status }));
  try {
    const invoices = await manager.find(Invoice, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } });
    evidence.invoices = invoices.map(row => ({ id: row.id, paymentStatus: row.paymentStatus }));
    evidence.payments = invoices.length ? states(await manager.find(Payment, { where: { invoiceId: In(invoices.map(row => row.id)) }, order: { id: 'ASC' } })) : [];
    evidence.cashSettlements = states(await manager.find(CashSettlement, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }));
    evidence.cashIntents = states(await manager.find(CashPaymentIntent, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } }));
    evidence.visitPayments = booking.visitGroupId ? states(await manager.find(VisitGroupPayment, { where: { visitGroupId: booking.visitGroupId }, order: { id: 'ASC' } })) : [];
    const reservations = await manager.find(VoucherReservation, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } });
    evidence.voucherReservations = reservations.map(row => ({ id: row.id, state: row.state }));
    const claims = await manager.find(VoucherClaim, { where: [
      { sourceId: In(scopeIds) }, ...(reservations.length ? [{ id: In(reservations.map(row => row.claimId)) }] : []),
    ], order: { id: 'ASC' } });
    evidence.voucherClaims = ids(claims);
    const links = await manager.find(VoucherPaymentLink, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } });
    evidence.voucherLinks = ids(links);
    const fundingWhere = [
      ...(links.length ? [{ linkId: In(links.map(row => row.id)) }] : []),
      ...(invoices.length ? [{ invoiceId: In(invoices.map(row => row.id)) }] : []),
    ];
    evidence.voucherFunding = fundingWhere.length ? (await manager.find(VoucherFundingEntry, { where: fundingWhere, order: { id: 'ASC' } }))
      .map(row => ({ id: row.id, kind: row.kind })) : [];
    // Any parts source remains an internal obligation; do not infer physical receipt/return.
    evidence.partRequests = ids(await manager.find(PartRequest, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }));
    evidence.partCustodies = ids(await manager.find(PartCustody, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }));
  } catch {
    // Missing legacy schema or failed reads never become absence of money/parts.
    reasonCodes.push('EVIDENCE_UNAVAILABLE');
  }
  for (const [kind, rows] of Object.entries(evidence)) if (rows.length) reasonCodes.push(`${kind.toUpperCase()}_PRESENT`);
  const unbilled = !!proof?.workStopped && reasonCodes.length === 1;
  return {
    customer: {
      version: 1, state: unbilled ? 'VERIFIED_WORK_STOPPED_UNBILLED' : 'FINANCIAL_REVIEW_REQUIRED',
      customerPayableVnd: null, newCollectionAllowed: false, historicalQuoteOnly: true,
      reviewRequired: true, refundState: 'NOT_DETERMINED',
      message: 'Báo giá cũ chỉ để xem lịch sử, không phải yêu cầu thanh toán cho công việc đã dừng. FixHome đang đối soát nghĩa vụ cũ; chưa xác nhận số tiền phải trả hoặc hoàn tiền.',
    },
    reasonCodes, evidence,
  };
}

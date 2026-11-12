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

type OnsiteProof = Awaited<ReturnType<typeof verifiedOnsiteInterruption>>;

/**
 * Informational only. STOP is not proof of genuine failed work, a zero receivable or refund.
 * `known.proof` is for a caller that has already seen an interruption receipt for this order and
 * computed verifiedOnsiteInterruption for it; it is then not read a second time.
 */
export async function loadOnsiteStopFinance(manager: EntityManager, order: ServiceOrder, booking: Booking,
  known?: { proof: OnsiteProof }) {
  if (!known && !await hasOnsiteInterruption(manager, order.id)) return null;
  const proof = known ? known.proof : await verifiedOnsiteInterruption(manager, order, booking);
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
  // Every read starts at once (a read waits only for the rows it needs); results are taken in the
  // original order, so a failed read leaves the later kinds empty exactly as before.
  const reads = (() => {
    const invoices = manager.find(Invoice, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } });
    const reservations = manager.find(VoucherReservation, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } });
    const links = manager.find(VoucherPaymentLink, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } });
    return {
      invoices,
      payments: invoices.then(rows => rows.length ? manager.find(Payment, { where: { invoiceId: In(rows.map(row => row.id)) }, order: { id: 'ASC' } }) : []),
      cashSettlements: manager.find(CashSettlement, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }),
      cashIntents: manager.find(CashPaymentIntent, { where: { scopeId: In(scopeIds) }, order: { id: 'ASC' } }),
      visitPayments: booking.visitGroupId ? manager.find(VisitGroupPayment, { where: { visitGroupId: booking.visitGroupId }, order: { id: 'ASC' } }) : Promise.resolve([]),
      reservations,
      claims: reservations.then(rows => manager.find(VoucherClaim, { where: [
        { sourceId: In(scopeIds) }, ...(rows.length ? [{ id: In(rows.map(row => row.claimId)) }] : []),
      ], order: { id: 'ASC' } })),
      links,
      funding: Promise.all([links, invoices]).then(([linkRows, invoiceRows]) => {
        const fundingWhere = [
          ...(linkRows.length ? [{ linkId: In(linkRows.map(row => row.id)) }] : []),
          ...(invoiceRows.length ? [{ invoiceId: In(invoiceRows.map(row => row.id)) }] : []),
        ];
        return fundingWhere.length ? manager.find(VoucherFundingEntry, { where: fundingWhere, order: { id: 'ASC' } }) : [];
      }),
      // Any parts source remains an internal obligation; do not infer physical receipt/return.
      partRequests: manager.find(PartRequest, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }),
      partCustodies: manager.find(PartCustody, { where: { serviceOrderId: order.id }, order: { id: 'ASC' } }),
    };
  })();
  // A read that fails after an earlier one already failed is never awaited below; keep it from becoming unhandled.
  for (const read of Object.values(reads)) (read as Promise<unknown>).catch(() => undefined);
  try {
    evidence.invoices = (await reads.invoices).map(row => ({ id: row.id, paymentStatus: row.paymentStatus }));
    evidence.payments = states(await reads.payments);
    evidence.cashSettlements = states(await reads.cashSettlements);
    evidence.cashIntents = states(await reads.cashIntents);
    evidence.visitPayments = states(await reads.visitPayments);
    evidence.voucherReservations = (await reads.reservations).map(row => ({ id: row.id, state: row.state }));
    evidence.voucherClaims = ids(await reads.claims);
    evidence.voucherLinks = ids(await reads.links);
    evidence.voucherFunding = (await reads.funding).map(row => ({ id: row.id, kind: row.kind }));
    evidence.partRequests = ids(await reads.partRequests);
    evidence.partCustodies = ids(await reads.partCustodies);
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

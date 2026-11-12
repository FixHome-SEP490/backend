import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { PaymentStatus } from '../../shared/enums';
import { CashPaymentIntent } from '../finance/entities/cash-payment-intent.entity';
import { Payment } from '../finance/entities/payment.entity';
import { PartCustody } from '../part-requests/entities/part-custody.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { VoucherClaim, VoucherReservation } from '../vouchers/entities/voucher.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import type { Booking } from '../bookings/entities/booking.entity';
import { CashSettlement } from './entities/cash-settlement.entity';
import { Invoice } from './entities/invoice.entity';
import type { ServiceOrder } from './entities/service-order.entity';
import { loadOnsiteStopFinance } from './onsite-stop-finance';

const order = { id: 'o1', bookingId: 'b1', paymentStatus: PaymentStatus.UNPAID } as ServiceOrder;
const booking = { id: 'b1', visitGroupId: null } as unknown as Booking;

/** A manager answering each entity from `rows`; an entity in `failing` rejects. Records every entity read. */
function managerWith(rows: Map<unknown, object[]>, failing: unknown[] = []) {
  const reads: unknown[] = [];
  const find = vi.fn(async (entity: unknown) => {
    reads.push(entity);
    if (failing.includes(entity)) throw new Error('relation does not exist');
    return rows.get(entity) ?? [];
  });
  const findOne = vi.fn(async (entity: unknown) => { reads.push(entity); return null; });
  return { manager: { find, findOne } as unknown as EntityManager, reads };
}

describe('stopped-work finance view', () => {
  it('uses the proof it is handed and reads no interruption receipt again', async () => {
    const { manager, reads } = managerWith(new Map<unknown, object[]>([[Invoice, [{ id: 'i1', paymentStatus: 'unpaid' }]], [Payment, [{ id: 'p1', status: 'pending' }]]]));
    const view = await loadOnsiteStopFinance(manager, order, booking, { proof: null });
    expect(reads).not.toContain(AuditLog);
    expect(view?.evidence.invoices).toEqual([{ id: 'i1', paymentStatus: 'unpaid' }]);
    expect(view?.evidence.payments).toEqual([{ id: 'p1', status: 'pending' }]);
    expect(view?.reasonCodes).toEqual(['FAILED_WORK_NOT_PROVEN', 'STOP_PROOF_INVALID_OR_NOT_FINALIZED', 'INVOICES_PRESENT', 'PAYMENTS_PRESENT']);
  });

  it('without a handed proof, an order with no interruption receipt has no finance view', async () => {
    const { manager, reads } = managerWith(new Map());
    expect(await loadOnsiteStopFinance(manager, order, booking)).toBeNull();
    expect(reads).toEqual([AuditLog]);
  });

  it('a failed read keeps the kinds read before it, leaves the later kinds empty and says evidence is unavailable', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const all = new Map<unknown, object[]>([
        [Invoice, [{ id: 'i1', paymentStatus: 'unpaid' }]], [CashSettlement, [{ id: 'c1', status: 'declared' }]],
        [CashPaymentIntent, [{ id: 'ci1', status: 'open' }]], [VoucherReservation, [{ id: 'r1', state: 'held', claimId: 'vc1' }]],
        [VoucherClaim, [{ id: 'vc1' }]], [VoucherPaymentLink, [{ id: 'l1' }]], [VoucherFundingEntry, [{ id: 'f1', kind: 'x' }]],
        [PartRequest, [{ id: 'pr1' }]], [PartCustody, [{ id: 'pc1' }]],
      ]);
      // CashPaymentIntent and PartCustody fail: everything before the first failure is kept, the rest is empty.
      const { manager } = managerWith(all, [CashPaymentIntent, PartCustody]);
      const view = await loadOnsiteStopFinance(manager, order, booking, { proof: null });
      expect(view?.evidence).toMatchObject({
        invoices: [{ id: 'i1', paymentStatus: 'unpaid' }], payments: [], cashSettlements: [{ id: 'c1', status: 'declared' }],
        cashIntents: [], voucherReservations: [], voucherClaims: [], voucherLinks: [], voucherFunding: [], partRequests: [], partCustodies: [],
      });
      expect(view?.reasonCodes).toContain('EVIDENCE_UNAVAILABLE');
      expect(view?.customer.state).toBe('FINANCIAL_REVIEW_REQUIRED');
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { EntityManager, In } from 'typeorm';
import { BookingStatus, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { Payment } from '../finance/entities/payment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { repairFailureIncident } from '../service-orders/repair-failure-incident';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { CheckoutFacts, FailureFacts, ReservationState, SettlementFacts } from './voucher.types';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';
import { UnavailableVoucherEvidence } from './voucher.ports';
import { canReleaseVoucherReservation } from './voucher-provider-ledger';
import { loadVoucherSettlementFacts } from './voucher-settlement-evidence';
import { lockVoucherFundingReservation } from './voucher-funding-lock';
import { VoucherPaymentLink } from './entities/voucher-funding.entity';
import { assertVoucherFundingSchemaReady } from './voucher-funding-readiness';

/** Incident evidence is read from durable order, case and audit rows in the voucher transaction. */
@Injectable()
export class RepairFailureVoucherEvidence extends UnavailableVoucherEvidence {
  async checkout(manager: EntityManager, customerId: string, scopeId: string): Promise<CheckoutFacts> {
    const conflict = (): never => { throw new ConflictException('Đơn thanh toán chưa đủ điều kiện áp dụng ưu đãi.'); };
    if (!manager.queryRunner?.isTransactionActive) conflict();
    await assertVoucherFundingSchemaReady(manager);
    const facts = await loadVoucherPreviewInvoices(manager, customerId, scopeId, true);
    const invoiceIds = facts.invoices.map(invoice => invoice.invoiceId);
    // Legacy FAILED/CANCELLED is not signed proof that a provider returned money.
    // Checkout must start before any collection attempt, including reconciliation holds.
    if (!invoiceIds.length || await manager.exists(Payment, { where: {
      invoiceId: In(invoiceIds),
    } }) || await manager.exists(CashSettlement, { where: {
      serviceOrderId: scopeId,
    } }) || await manager.exists(VisitGroupPayment, { where: {
      visitGroupId: scopeId,
    } })) conflict();
    const eligibleSubtotalVnd = facts.invoices.reduce((sum, invoice) =>
      sum + invoice.laborTotalVnd + invoice.fixHomePartsTotalVnd, 0);
    if (!Number.isSafeInteger(eligibleSubtotalVnd) || eligibleSubtotalVnd <= 0) conflict();
    return { customerId, scopeId, snapshotId: randomUUID(), finalized: true,
      paymentState: 'NOT_STARTED', eligibleSubtotalVnd, items: facts.services };
  }

  async settlement(manager: EntityManager, settlementId: string): Promise<SettlementFacts> {
    return loadVoucherSettlementFacts(manager, settlementId);
  }
  async canRelease(manager: EntityManager, reservationId: string): Promise<boolean> {
    const reservation = await lockVoucherFundingReservation(manager, reservationId);
    if (reservation.state !== ReservationState.RESERVED) return false;
    const link = await manager.findOne(VoucherPaymentLink, { where: { reservationId } });
    if (!link) {
      // No bound collection: lock the same frozen invoices and prove that no
      // legacy attempt can still collect before releasing capacity.
      try {
        await this.checkout(manager, reservation.customerId, reservation.scopeId);
        return true;
      } catch (error) {
        if (error instanceof ConflictException || error instanceof ForbiddenException) return false;
        throw error;
      }
    }
    return canReleaseVoucherReservation(manager, reservationId);
  }
  async failure(manager: EntityManager, incidentId: string): Promise<FailureFacts> {
    const denied = () => { throw new ForbiddenException('Sự cố sửa chữa chưa đủ điều kiện cấp ưu đãi.'); };
    if (!isUUID(incidentId, '4')) denied();
    const incident = await manager.findOneBy(SupportCase, { id: incidentId, caseType: SupportCaseType.MID_JOB_INTERRUPTION });
    if (!incident || incident.id !== incidentId || !incident.serviceOrderId || !incident.bookingId || !incident.customerId) denied();
    const order = await manager.findOne(ServiceOrder, { where: { id: incident.serviceOrderId }, lock: { mode: 'pessimistic_read' } });
    const booking = await manager.findOne(Booking, { where: { id: incident.bookingId }, lock: { mode: 'pessimistic_read' } });
    if (!order || !booking || order.status !== ServiceOrderStatus.CANCELLED || booking.status !== BookingStatus.CANCELLED ||
        order.bookingId !== booking.id || booking.customerId !== incident.customerId) denied();
    const linked = await repairFailureIncident(manager, order);
    if (!linked || linked.incident.id !== incident.id) denied();
    if (booking.visitGroupId) {
      const group = await manager.findOne(VisitGroup, { where: { id: booking.visitGroupId }, lock: { mode: 'pessimistic_read' } });
      if (!group || group.customerId !== booking.customerId) denied();
      return { sourceKind: 'VISIT_GROUP', sourceId: group.id, customerId: booking.customerId, eligible: true, reason: 'REPAIR_FAILED' };
    }
    return { sourceKind: 'SOLO', sourceId: order.id, customerId: booking.customerId, eligible: true, reason: 'REPAIR_FAILED' };
  }
}

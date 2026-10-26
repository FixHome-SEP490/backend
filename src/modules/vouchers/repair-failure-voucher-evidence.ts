import { ForbiddenException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { EntityManager } from 'typeorm';
import { BookingStatus, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { repairFailureIncident } from '../service-orders/repair-failure-incident';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { FailureFacts } from './voucher.types';
import { UnavailableVoucherEvidence } from './voucher.ports';

/** Incident evidence is read from durable order, case and audit rows in the voucher transaction. */
@Injectable()
export class RepairFailureVoucherEvidence extends UnavailableVoucherEvidence {
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

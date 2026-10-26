import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BookingStatus, Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { RepairFailureVoucherEvidence } from './repair-failure-voucher-evidence';

describe('voucher repair failure evidence', () => {
  const customerId = randomUUID();
  const incidentId = randomUUID();
  const orderId = randomUUID();
  const bookingId = randomUUID();
  const groupId = randomUUID();
  const techId = randomUUID();
  const order = { id: orderId, bookingId, status: ServiceOrderStatus.CANCELLED };
  const booking = { id: bookingId, customerId, visitGroupId: groupId, status: BookingStatus.CANCELLED };
  const incident = { id: incidentId, bookingId, serviceOrderId: orderId, customerId, caseType: SupportCaseType.MID_JOB_INTERRUPTION, technicianId: techId, createdByUserId: techId };
  const audit = { action: 'VISIT_DEVICE_REPAIR_FAILED', resourceType: 'service_order', resourceId: orderId, actorRole: Role.TECHNICIAN, actorUserId: techId,
    after: { version: 1, incidentId, request: { reason: 'other', note: null, parts: [], photoEvidenceIds: [] } } };
  function manager(rows = { order, booking, incident, audit, group: { id: groupId, customerId } }) {
    return {
      findOne: async (entity: unknown) => entity === ServiceOrder ? rows.order : entity === Booking ? rows.booking : entity === VisitGroup ? rows.group : null,
      findOneBy: async (entity: unknown, where: { id: string }) => entity === SupportCase && rows.incident.id === where.id ? rows.incident : null,
      find: async (entity: unknown) => entity === AuditLog ? [rows.audit] : [],
    } as any;
  }
  it('normalizes a linked failed child to its owned visit group', async () => {
    const evidence = new RepairFailureVoucherEvidence();
    expect(await evidence.failure(manager(), incidentId)).toEqual({ sourceKind: 'VISIT_GROUP', sourceId: groupId, customerId, eligible: true, reason: 'REPAIR_FAILED' });
  });
  it('uses the failed order as the stable source for a solo repair', async () => {
    const evidence = new RepairFailureVoucherEvidence();
    expect(await evidence.failure(manager({ order, booking: { ...booking, visitGroupId: null }, incident, audit, group: { id: groupId, customerId } }), incidentId))
      .toEqual({ sourceKind: 'SOLO', sourceId: orderId, customerId, eligible: true, reason: 'REPAIR_FAILED' });
  });
  it('rejects an unrelated incident, owner mismatch and unlinked cancellation', async () => {
    const evidence = new RepairFailureVoucherEvidence();
    await expect(evidence.failure(manager(), randomUUID())).rejects.toThrow();
    await expect(evidence.failure(manager({ order, booking: { ...booking, customerId: randomUUID() }, incident, audit, group: { id: groupId, customerId } }), incidentId)).rejects.toThrow();
    await expect(evidence.failure(manager({ order, booking, incident, audit: { ...audit, after: { ...audit.after, incidentId: randomUUID() } }, group: { id: groupId, customerId } }), incidentId)).rejects.toThrow();
  });
});

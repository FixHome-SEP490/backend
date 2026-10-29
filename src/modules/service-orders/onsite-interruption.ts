import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { EntityManager } from 'typeorm';
import { BookingStatus, CheckInResult, Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { CannotContinueDto, reasonMatchesClass, TechnicianReportReasonCode } from '../support-cases/dto/technician-report.dto';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';

export const ONSITE_INTERRUPTION_ACTION = 'TECHNICIAN_CANNOT_CONTINUE_ONSITE';
export const ONSITE_STOP_ACTION = 'TECHNICIAN_ONSITE_STOP_FINALIZED';

export function onsiteInterruptionRequest(input: CannotContinueDto) {
  const photos = input?.photoEvidenceIds ?? [];
  if (!input || !isUUID(input.commandId, '4') || !reasonMatchesClass(input.reasonClass, input.reasonCode)
    || [TechnicianReportReasonCode.CUSTOMER_ABSENT, TechnicianReportReasonCode.CUSTOMER_CANCELLED].includes(input.reasonCode)
    || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.trim().length > 2000
    || !Array.isArray(photos) || photos.length > 3 || photos.some(id => typeof id !== 'string' || !isUUID(id, '4'))
    || new Set(photos.map(id => id.toLowerCase())).size !== photos.length) {
    throw new BadRequestException('Chọn lý do không thể tiếp tục và tối đa 3 ảnh hợp lệ, không trùng nhau.');
  }
  return { commandId: input.commandId.toLowerCase(), reasonClass: input.reasonClass, reasonCode: input.reasonCode,
    reason: input.reason.trim(), photoEvidenceIds: photos.map(id => id.toLowerCase()).sort() };
}

export function onsiteInterruptionFingerprint(orderId: string, actorId: string, request: ReturnType<typeof onsiteInterruptionRequest>) {
  return createHash('sha256').update(JSON.stringify({ orderId: orderId.toLowerCase(), actorId: actorId.toLowerCase(), request })).digest('hex');
}

/** Existence blocks a second outcome even when a damaged receipt cannot grant continuation. */
export async function hasOnsiteInterruption(manager: EntityManager, orderId: string): Promise<boolean> {
  const row = await manager.findOne(AuditLog, { where: {
    action: ONSITE_INTERRUPTION_ACTION, resourceType: 'service_order', resourceId: orderId,
  } });
  if (row?.action === ONSITE_INTERRUPTION_ACTION) return true;
  const stop = await manager.findOne(AuditLog, { where: {
    action: ONSITE_STOP_ACTION, resourceType: 'service_order', resourceId: orderId,
  } });
  return stop?.action === ONSITE_STOP_ACTION;
}

export async function assertNoOnsiteInterruption(manager: EntityManager, orderId: string): Promise<void> {
  if (await hasOnsiteInterruption(manager, orderId)) {
    throw new ConflictException('Đã ghi nhận gián đoạn tại nhà khách. Nghĩa vụ của đơn cũ cần được đối soát riêng.');
  }
}

/** Same strict source-proof pattern as repairFailureIncident; case status is not authority. */
export async function verifiedOnsiteInterruption(manager: EntityManager, order: ServiceOrder, booking: Booking) {
  const receipts = await manager.find(AuditLog, { where: {
    action: ONSITE_INTERRUPTION_ACTION, resourceType: 'service_order', resourceId: order.id,
  } });
  if (receipts.length !== 1 || booking.id !== order.bookingId || booking.status !== BookingStatus.MATCHED) return null;
  const receipt = receipts[0];
  const after = receipt.after;
  const finals = await manager.find(AuditLog, { where: {
    action: ONSITE_STOP_ACTION, resourceType: 'service_order', resourceId: order.id,
  } });
  if (finals.length > 1) return null;
  const final = finals[0];
  const stopped = final?.after;
  if (receipt.actorRole !== Role.TECHNICIAN || !receipt.actorUserId || after?.version !== 1
    || after.serviceOutcome !== 'VERIFIED_INTERRUPTION_RECORDED' || after.sourceBookingId !== booking.id
    || after.customerId !== booking.customerId || after.sourceVisitGroupId !== (booking.visitGroupId ?? null)
    || after.serviceOrderStatus !== order.status || ![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status)
    || typeof after.incidentId !== 'string' || !isUUID(after.incidentId, '4')
    || typeof after.assignmentId !== 'string' || !isUUID(after.assignmentId, '4')
    || typeof after.checkInId !== 'string' || !isUUID(after.checkInId, '4')
    || !after.request || typeof after.request !== 'object'
    || !Array.isArray((after.request as CannotContinueDto).photoEvidenceIds)) return null;
  let request: ReturnType<typeof onsiteInterruptionRequest>;
  try { request = onsiteInterruptionRequest(after.request as CannotContinueDto); } catch { return null; }
  const fingerprint = onsiteInterruptionFingerprint(order.id, receipt.actorUserId, request);
  if (after.fingerprint !== fingerprint) return null;
  const incident = await manager.findOneBy(SupportCase, { id: after.incidentId,
    bookingId: booking.id, serviceOrderId: order.id, customerId: booking.customerId,
    technicianId: receipt.actorUserId, createdByUserId: receipt.actorUserId,
    caseType: SupportCaseType.TECHNICIAN_REPLACEMENT });
  if (!incident || incident.interruptionCommandId !== request.commandId || incident.interruptionFingerprint !== fingerprint) return null;
  // The final proof binds the original immutable request, not later case edits.
  if (!final && (incident.reason !== request.reason || incident.reasonClass !== request.reasonClass || incident.reasonCode !== request.reasonCode
    || !Array.isArray(incident.evidenceRefs)
    || JSON.stringify([...incident.evidenceRefs].sort()) !== JSON.stringify(request.photoEvidenceIds))) return null;
  const assignment = await manager.findOneBy(TechnicianAssignment, { id: after.assignmentId,
    serviceOrderId: order.id, technicianId: receipt.actorUserId });
  const checkin = await manager.findOneBy(ArrivalCheckIn, { id: after.checkInId,
    serviceOrderId: order.id, technicianId: receipt.actorUserId, result: CheckInResult.VALID });
  if (!assignment || !checkin || !validAssignmentCheckIn(assignment, checkin)) return null;
  if (final) {
    const stopAt = typeof stopped?.stoppedAt === 'string' ? Date.parse(stopped.stoppedAt) : NaN;
    if (final.actorRole !== Role.TECHNICIAN || final.actorUserId !== receipt.actorUserId
      || stopped?.version !== 1 || stopped.disposition !== 'STOPPED_OLD_OBLIGATIONS_PRESERVED'
      || stopped.receiptId !== receipt.id || stopped.incidentId !== incident.id
      || stopped.sourceBookingId !== booking.id || stopped.customerId !== booking.customerId
      || stopped.sourceVisitGroupId !== (booking.visitGroupId ?? null)
      || stopped.assignmentId !== assignment.id || stopped.checkInId !== checkin.id
      || stopped.fingerprint !== fingerprint || stopped.commandId !== request.commandId
      || stopped.serviceOrderStatus !== order.status || assignment.isActive !== false
      || assignment.unassignReason !== ONSITE_STOP_ACTION || !assignment.unassignedAt
      || !Number.isFinite(stopAt) || stopAt < new Date(checkin.checkedInAt).getTime() || stopAt > Date.now()
      || new Date(assignment.unassignedAt).getTime() !== stopAt
      || await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, isActive: true })) return null;
  } else if (!assignment.isActive) return null;
  if (booking.visitGroupId) {
    const group = await manager.findOneBy(VisitGroup, { id: booking.visitGroupId, customerId: booking.customerId });
    const item = await manager.findOneBy(VisitGroupItem, { groupId: booking.visitGroupId, bookingId: booking.id });
    if (!group || !item || (final ? item.outcome !== 'interrupted' || !item.outcomeAt
      || new Date(item.outcomeAt).getTime() !== Date.parse(stopped!.stoppedAt as string) : item.outcome != null)) return null;
  }
  return { incident, request, fingerprint, receipt, assignment, checkin, workStopped: !!final };
}

export function validAssignmentCheckIn(assignment: TechnicianAssignment, checkin: ArrivalCheckIn): boolean {
  if (!assignment.assignedAt || !checkin.checkedInAt) return false;
  const assignedAt = new Date(assignment.assignedAt).getTime();
  const checkedInAt = new Date(checkin.checkedInAt).getTime();
  return Number.isFinite(assignedAt) && Number.isFinite(checkedInAt) && checkedInAt >= assignedAt && checkedInAt <= Date.now();
}

/** No amounts, evidence, actor IDs or private financial/provider data leave this read model. */
export function onsiteContinuationResult(order: ServiceOrder, booking: Booking, incidentId: string | null, workStopped = false) {
  return { version: 1, incidentId,
    operationalDisposition: workStopped ? 'STOPPED' : incidentId ? 'INTERRUPTION_RECORDED' : null,
    workStopped, assignmentReleased: workStopped,
    serviceOutcome: incidentId ? 'VERIFIED_INTERRUPTION_RECORDED' : null,
    serviceOrderStatus: order.status, terminalTransitionApplied: false,
    oldObligations: { reviewRequired: !!incidentId, quotePreserved: true, moneyPreserved: true, partsPreserved: true,
      physicalReturnAcceptance: 'MANUAL_SERVICE_MANAGER_ONLY', legacyPartReturnState: 'NOT_VERIFIED' },
    customerContinuation: { eligible: !!incidentId, independentNewBookingAllowed: !!incidentId,
      prefilledRebookAvailable: false, requiresNewSchedule: true, requiresPricingRevalidation: true,
      requiresCustomerConfirmation: true, source: incidentId ? { serviceOrderId: order.id, bookingId: booking.id,
        incidentId, visitGroupId: booking.visitGroupId ?? null } : null } };
}

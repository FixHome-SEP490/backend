import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { EntityManager } from 'typeorm';
import { BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { assertNoOnsiteInterruption, validAssignmentCheckIn } from '../service-orders/onsite-interruption';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { SOLO_CONTACT, soloContactEvidence } from '../service-orders/onsite-contact';
import { SoloContactAttemptDto } from './dto/solo-contact.dto';
import type { SupportCaseActor } from './support-cases.service';

export async function assertSoloContactEligible(manager: EntityManager, order: ServiceOrder, booking: Booking) {
  if (booking.visitGroupId != null || await manager.findOneBy(VisitGroupItem, { bookingId: booking.id })) {
    throw new ConflictException('Thiết bị thuộc lượt nhiều thiết bị; cần dùng lệnh cho cả lượt.');
  }
  // The booked slot is an arrival window, not a deadline for active onsite work.
  if (booking.status !== BookingStatus.MATCHED ||
    order.completionRequestedAt || ![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status)) {
    throw new ConflictException('Đơn không còn ở giai đoạn liên hệ tại nhà khách.');
  }
  // Read only: never acquire invoice locks after the order lock, or alter obligations.
  if (order.paymentStatus !== PaymentStatus.UNPAID || await manager.findOneBy(Invoice, { serviceOrderId: order.id })) {
    throw new ConflictException('Trạng thái tài chính cần quản lý đối soát trước khi dừng sửa.');
  }
}

/** Same Booking -> Order -> Assignment hierarchy as the stop writer. */
export async function soloContactScope(manager: EntityManager, orderId: string, actor: SupportCaseActor) {
  if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này.');
  const ref = await manager.findOneBy(ServiceOrder, { id: orderId });
  const owned = ref && await manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, technicianId: actor.id });
  if (!ref || !owned) throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
  const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
  const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
  if (!booking || !order || order.bookingId !== booking.id) throw new ConflictException('Thông tin đơn sửa chữa đã thay đổi.');
  await assertSoloContactEligible(manager, order, booking);
  await assertNoOnsiteInterruption(manager, order.id);
  const assignments = await manager.find(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true }, lock: { mode: 'pessimistic_write' } });
  const assignment = assignments[0];
  if (assignments.length !== 1 || assignment.technicianId !== actor.id) throw new ForbiddenException('Bạn không còn phụ trách đơn này.');
  const checkins = await manager.find(ArrivalCheckIn, { where: { serviceOrderId: order.id, technicianId: actor.id, result: CheckInResult.VALID }, order: { checkedInAt: 'DESC' } });
  const checkin = checkins.find(c => validAssignmentCheckIn(assignment, c));
  if (!checkin) throw new ConflictException('Cần check-in hợp lệ cho lần phân công hiện tại.');
  return { booking, order, assignment, checkin };
}

export async function recordSoloContact(manager: EntityManager, orderId: string, input: SoloContactAttemptDto, actor: SupportCaseActor) {
  if (!input || !isUUID(input.commandId, '4') || !['CALL_ATTEMPT', 'IN_APP_NOTIFICATION'].includes(input.kind)) {
    throw new BadRequestException('Chọn cách liên hệ và mã lệnh hợp lệ.');
  }
  const current = await soloContactScope(manager, orderId, actor);
  const evidence = await soloContactEvidence(manager, current, actor);
  const prior = await manager.find(AuditLog, { where: { action: SOLO_CONTACT, resourceType: 'service_order', resourceId: current.order.id } });
  const replay = prior.find(row => row.after?.commandId === input.commandId.toLowerCase());
  if (replay) {
    if (replay.actorUserId !== actor.id || replay.after?.kind !== input.kind || !evidence.rows.some(row => row.id === replay.id)) {
      throw new ConflictException('Mã lệnh liên hệ đã dùng với nội dung hoặc lần phân công khác.');
    }
    return { ...evidence.readiness, evidenceId: replay.id, recordedAt: replay.createdAt, callConnectionVerified: false };
  }
  if (input.kind === 'IN_APP_NOTIFICATION' && evidence.readiness.notificationSent) {
    throw new ConflictException('?? g?i th?ng b?o cho kh?ch trong l?n ph?n c?ng n?y.');
  }
  const notificationId = input.kind === 'IN_APP_NOTIFICATION' ? randomUUID() : null;
  if (notificationId) await manager.insert(Notification, { id: notificationId, userId: current.booking.customerId,
    type: SOLO_CONTACT, referenceType: 'SERVICE_ORDER', referenceId: current.order.id, isRead: false,
    title: 'Kỹ thuật viên đang chờ liên hệ', message: 'Kỹ thuật viên đã đến địa chỉ hẹn. Vui lòng liên hệ để tiếp tục sửa chữa.' });
  const row = await manager.save(AuditLog, manager.create(AuditLog, { actorUserId: actor.id, actorRole: actor.role,
    createdAt: new Date(Date.now()), action: SOLO_CONTACT, resourceType: 'service_order', resourceId: current.order.id,
    after: { version: 1, commandId: input.commandId.toLowerCase(), kind: input.kind, orderId: current.order.id,
      customerId: current.booking.customerId, assignmentId: current.assignment.id, checkInId: current.checkin.id,
      notificationId, origin: 'TECHNICIAN_CONTACT_ACTION', callConnectionVerified: false } }));
  return { ...(await soloContactEvidence(manager, current, actor)).readiness,
    evidenceId: row.id, recordedAt: row.createdAt, callConnectionVerified: false };
}

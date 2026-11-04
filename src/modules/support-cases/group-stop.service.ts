import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AccountStatus, BookingStatus, CheckInResult, PaymentStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Booking } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { hasOnsiteInterruption, onsiteInterruptionRequest, validAssignmentCheckIn } from '../service-orders/onsite-interruption';
import { User } from '../users/entities/user.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VISIT_GROUP_DEVICE_LIMIT } from '../visit-groups/visit-group.dto';
import { GroupContactAttemptDto, GroupStopDto } from './dto/group-stop.dto';
import { SupportCase } from './entities';
import { SupportCaseActor } from './support-cases.service';
import { TechnicianReportService } from './technician-report.service';
import { contactReadiness } from '../service-orders/onsite-contact';
export { contactReadiness } from '../service-orders/onsite-contact';

export const GROUP_CONTACT = 'VISIT_CONTACT_ATTEMPT';
export const GROUP_STOP = 'VISIT_GROUP_STOPPED';

@Injectable()
export class GroupStopService {
  constructor(private readonly dataSource: DataSource, private readonly audit: AuditLogService,
    private readonly reports: TechnicianReportService) {}

  /** Lead -> group -> ALL bookings -> orders -> assignments. Never lock finance after orders. */
  private async scope(manager: EntityManager, groupId: string) {
    const refs = await manager.find(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
    if (!refs.length || refs.length > VISIT_GROUP_DEVICE_LIMIT) throw new NotFoundException('Không tìm thấy lượt sửa chữa.');
    const lead = await manager.findOne(Booking, { where: { id: refs[0].bookingId }, lock: { mode: 'pessimistic_write' } });
    const group = await manager.findOne(VisitGroup, { where: { id: groupId }, lock: { mode: 'pessimistic_write' } });
    if (!lead || !group) throw new NotFoundException('Không tìm thấy lượt sửa chữa.');
    const bookings = await manager.find(Booking, { where: { visitGroupId: groupId }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
    const items = await manager.find(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
    if (bookings.length !== items.length || items.length !== refs.length ||
      items.some(item => !bookings.some(b => b.id === item.bookingId && b.customerId === group.customerId))) {
      throw new ConflictException('Danh sách thiết bị đã thay đổi.');
    }
    const children = [];
    for (const booking of bookings) {
      const order = await manager.findOne(ServiceOrder, { where: { bookingId: booking.id }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new ConflictException('Thiết bị chưa có đơn sửa chữa.');
      children.push({ booking, order, item: items.find(item => item.bookingId === booking.id)! });
    }
    return { group, children };
  }

  private async current(manager: EntityManager, groupId: string, orderId: string, actor: SupportCaseActor) {
    const order = await manager.findOneBy(ServiceOrder, { id: orderId });
    const booking = order && await manager.findOneBy(Booking, { id: order.bookingId, visitGroupId: groupId });
    const item = booking && await manager.findOneBy(VisitGroupItem, { groupId, bookingId: booking.id });
    if (!booking || !item || !order) throw new NotFoundException('Không tìm thấy thiết bị trong lượt sửa.');
    const assignments = await manager.find(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true }, lock: { mode: 'pessimistic_write' } });
    const assignment = assignments[0];
    if (assignments.length !== 1 || assignment.technicianId !== actor.id) throw new ForbiddenException('Bạn không còn phụ trách thiết bị này.');
    if (booking.status !== BookingStatus.MATCHED || item.outcome != null || order.completionRequestedAt ||
      ![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status) || order.paymentStatus !== PaymentStatus.UNPAID) {
      throw new ConflictException('Thiết bị không còn ở giai đoạn liên hệ hoặc dừng sửa.');
    }
    const checkins = await manager.find(ArrivalCheckIn, { where: { serviceOrderId: order.id, technicianId: actor.id, result: CheckInResult.VALID }, order: { checkedInAt: 'ASC' } });
    const checkin = checkins.find(c => validAssignmentCheckIn(assignment, c));
    if (!checkin) throw new ConflictException('Cần check-in hợp lệ cho lần phân công hiện tại.');
    return { order, booking, assignment, checkin };
  }

  private async evidence(manager: EntityManager, groupId: string, current: Awaited<ReturnType<GroupStopService['current']>>, actor: SupportCaseActor) {
    const rows = await manager.find(AuditLog, { where: { action: GROUP_CONTACT, resourceType: 'visit_group', resourceId: groupId, actorUserId: actor.id, actorRole: Role.TECHNICIAN }, order: { createdAt: 'ASC' } });
    const valid = rows.filter(row => row.after?.version === 1 && row.after.assignmentId === current.assignment.id &&
      row.after.checkInId === current.checkin.id && row.after.orderId === current.order.id && row.after.customerId === current.booking.customerId &&
      new Date(row.createdAt).getTime() >= new Date(current.checkin.checkedInAt).getTime() && new Date(row.createdAt).getTime() <= Date.now());
    let notified = false;
    for (const row of valid.filter(row => row.after?.kind === 'IN_APP_NOTIFICATION')) {
      const notification = typeof row.after?.notificationId === 'string' && await manager.findOneBy(Notification, {
        id: row.after.notificationId, userId: current.booking.customerId, type: GROUP_CONTACT, referenceType: 'VISIT_GROUP', referenceId: groupId,
      });
      if (notification && new Date(notification.createdAt).getTime() <= Date.now()) notified = true;
    }
    return { rows: valid, readiness: contactReadiness(valid.filter(row => row.after?.kind === 'CALL_ATTEMPT').map(row => new Date(row.createdAt).getTime()), notified, Date.now()) };
  }

  async readiness(groupId: string, orderId: string, actor: SupportCaseActor) {
    this.technician(actor);
    return this.dataSource.transaction(async manager => {
      await this.scope(manager, groupId);
      const current = await this.current(manager, groupId, orderId, actor);
      return (await this.evidence(manager, groupId, current, actor)).readiness;
    });
  }

  async contact(groupId: string, input: GroupContactAttemptDto, actor: SupportCaseActor) {
    this.technician(actor);
    return this.dataSource.transaction(async manager => {
      await this.scope(manager, groupId);
      const current = await this.current(manager, groupId, input.selectedOrderId, actor);
      const evidence = await this.evidence(manager, groupId, current, actor);
      const previous = await manager.find(AuditLog, { where: { action: GROUP_CONTACT, resourceType: 'visit_group', resourceId: groupId } });
      const replay = previous.find(row => row.after?.commandId === input.commandId.toLowerCase());
      if (replay) {
        if (replay.actorUserId !== actor.id || replay.after?.kind !== input.kind || replay.after.orderId !== input.selectedOrderId ||
          !evidence.rows.some(row => row.id === replay.id)) throw new ConflictException('Mã lệnh liên hệ đã dùng với nội dung khác.');
        return { ...evidence.readiness, evidenceId: replay.id, recordedAt: replay.createdAt, callConnectionVerified: false };
      }
      if (!['CALL_ATTEMPT', 'IN_APP_NOTIFICATION'].includes(input.kind)) throw new BadRequestException('Chọn cách liên hệ hợp lệ.');
      const notificationId = input.kind === 'IN_APP_NOTIFICATION' ? randomUUID() : null;
      if (notificationId) await manager.insert(Notification, { id: notificationId, userId: current.booking.customerId,
        type: GROUP_CONTACT, referenceType: 'VISIT_GROUP', referenceId: groupId, isRead: false,
        title: 'Kỹ thuật viên đang chờ liên hệ', message: 'Kỹ thuật viên đã đến địa chỉ hẹn. Vui lòng liên hệ để tiếp tục lượt sửa chữa.' });
      const row = await manager.save(AuditLog, manager.create(AuditLog, { actorUserId: actor.id, actorRole: actor.role,
        createdAt: new Date(Date.now()),
        action: GROUP_CONTACT, resourceType: 'visit_group', resourceId: groupId,
        after: { version: 1, commandId: input.commandId.toLowerCase(), kind: input.kind, orderId: current.order.id,
          customerId: current.booking.customerId, assignmentId: current.assignment.id, checkInId: current.checkin.id,
          notificationId, origin: 'TECHNICIAN_CONTACT_ACTION', callConnectionVerified: false } }));
      return { ...(await this.evidence(manager, groupId, current, actor)).readiness,
        evidenceId: row.id, recordedAt: row.createdAt, callConnectionVerified: false };
    });
  }

  async stop(groupId: string, input: GroupStopDto, actor: SupportCaseActor) {
    this.technician(actor);
    if (!['customer_absent', 'customer_unreachable'].includes(input.reasonCode)) throw new BadRequestException('Lý do này chỉ dừng từng thiết bị.');
    const request = onsiteInterruptionRequest(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ groupId, actorId: actor.id, selectedOrderId: input.selectedOrderId, request })).digest('hex');
    return this.dataSource.transaction(async manager => {
      const scope = await this.scope(manager, groupId);
      // Historical assignment authorizes exact readback after operational release.
      const belongs = scope.children.some(c => c.order.id === input.selectedOrderId);
      const owned = belongs && await manager.findOneBy(TechnicianAssignment, { serviceOrderId: input.selectedOrderId, technicianId: actor.id });
      if (!owned) throw new NotFoundException('Không tìm thấy lượt sửa chữa.');
      const logs = await manager.find(AuditLog, { where: { action: GROUP_STOP, resourceType: 'visit_group', resourceId: groupId } });
      const replay = logs.find(row => row.after?.commandId === request.commandId);
      if (replay) {
        if (replay.actorUserId !== actor.id || replay.after?.fingerprint !== fingerprint || !replay.after.result) throw new ConflictException('Mã lệnh đã dùng với nội dung khác.');
        return replay.after.result;
      }
      const current = await this.current(manager, groupId, input.selectedOrderId, actor);
      const evidence = await this.evidence(manager, groupId, current, actor);
      if (!evidence.readiness.ready) throw new ConflictException({ code: 'GROUP_CONTACT_NOT_READY', message: 'Cần hai lần gọi cách nhau ít nhất 5 phút, gửi thông báo và chờ đủ 10 phút từ lần gọi đầu.' });
      const eligible = [];
      const preserved = [];
      // Preflight every child before ANY stop write. Invoices are read only:
      // their mere existence preserves the child; never contend invoice -> order.
      for (const child of scope.children) {
        const { order, booking, item } = child;
        const invoice = await manager.findOneBy(Invoice, { serviceOrderId: order.id });
        if (order.status === ServiceOrderStatus.COMPLETED || order.status === ServiceOrderStatus.CANCELLED ||
          order.paymentStatus === PaymentStatus.PAID || order.completionRequestedAt || item.outcome != null) {
          if (await hasOnsiteInterruption(manager, order.id)) throw new ConflictException('Thiết bị đã có biên nhận gián đoạn; cần quản lý kiểm tra.');
          preserved.push({ bookingId: booking.id, orderId: order.id, orderStatus: order.status, outcome: item.outcome ?? null,
            disposition: 'PRESERVED', financialFollowupRequired: !!invoice });
          continue;
        }
        if (invoice || order.paymentStatus !== PaymentStatus.UNPAID) throw new ConflictException({ code: 'GROUP_FINANCE_REVIEW_REQUIRED', message: 'Trạng thái tài chính cần quản lý đối soát trước khi dừng lượt.' });
        if (await hasOnsiteInterruption(manager, order.id)) throw new ConflictException('Thiết bị đã có biên nhận gián đoạn.');
        await this.current(manager, groupId, order.id, actor);
        eligible.push(child);
      }
      if (!eligible.some(child => child.order.id === input.selectedOrderId)) throw new ConflictException('Thiết bị được chọn không còn đủ điều kiện.');
      const stopped = [];
      for (const child of eligible) {
        // Unique per-child command IDs fit existing unique support-case index.
        const hex = createHash('sha256').update(`${request.commandId}:${child.order.id}`).digest('hex');
        const childCommandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const result = await this.reports.stopWithinTransaction(manager, child.order.id, { ...request, commandId: childCommandId,
          photoEvidenceIds: child.order.id === input.selectedOrderId ? request.photoEvidenceIds : [] }, actor, request.commandId);
        stopped.push({ bookingId: child.booking.id, orderId: child.order.id, incidentId: result.incidentId,
          workStopped: true, assignmentReleased: true, operationalDisposition: 'STOPPED', financialFollowupRequired: true });
      }
      const result = { version: 1, groupId, commandId: request.commandId, stopped, preserved,
        oldObligationsPreserved: true, financialFollowupRequired: true, automaticLiabilityApplied: false };
      await this.audit.logWithManagerStrict(manager, { actorUserId: actor.id, actorRole: actor.role, action: GROUP_STOP,
        resourceType: 'visit_group', resourceId: groupId, after: { version: 1, commandId: request.commandId, fingerprint,
          evidenceIds: evidence.rows.map(row => row.id), request, selectedOrderId: input.selectedOrderId, result } });
      const staff = await manager.find(User, { where: { role: In([Role.SERVICE_MANAGER, Role.ADMIN]), status: AccountStatus.ACTIVE, isActive: true }, select: { id: true } });
      await manager.insert(Notification, [scope.group.customerId, ...staff.map(user => user.id)].map(userId => ({
        userId, type: GROUP_STOP, referenceType: 'VISIT_GROUP', referenceId: groupId, isRead: false,
        title: 'Lượt sửa chữa đã dừng', message: 'Đã ghi nhận gián đoạn cả lượt. Khách hàng có thể chọn thiết bị dừng để đặt lịch mới; nghĩa vụ cũ cần đối soát riêng.' })));
      return result;
    });
  }

  async incidents(groupId: string, actor: SupportCaseActor) {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role)) throw new ForbiddenException('Bạn không có quyền xem hồ sơ này.');
    const manager = this.dataSource.manager;
    const logs = await manager.find(AuditLog, { where: { action: GROUP_STOP, resourceType: 'visit_group', resourceId: groupId }, order: { createdAt: 'DESC' } });
    const items = await manager.find(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
    return Promise.all(logs.map(async log => ({ commandId: log.after?.commandId, recordedAt: log.createdAt,
      result: log.after?.result, contactEvidence: await manager.find(AuditLog, { where: {
        id: In(Array.isArray(log.after?.evidenceIds) ? log.after.evidenceIds as string[] : []), action: GROUP_CONTACT, resourceId: groupId,
      } }), children: await Promise.all(items.map(async item => {
        const order = await manager.findOneBy(ServiceOrder, { bookingId: item.bookingId });
        return { bookingId: item.bookingId, orderId: order?.id, orderStatus: order?.status, paymentStatus: order?.paymentStatus,
          completionRequestedAt: order?.completionRequestedAt, outcome: item.outcome ?? null,
          cases: order ? await manager.find(SupportCase, { where: { serviceOrderId: order.id } }) : [], financialFollowupRequired: true };
      })) })));
  }

  private technician(actor: SupportCaseActor) {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này.');
  }
}

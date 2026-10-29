import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AccountStatus, BookingStatus, CheckInResult, EvidenceType, Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Booking } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ReputationService } from '../reputation/reputation.service';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { SupportCase } from './entities';
import { respondByFor } from './support-case-policy';
import {
  CannotContinueDto, DecideTechnicianResponsibilityDto, reasonMatchesClass, TechnicianReportDto,
  TechnicianResponsibility,
} from './dto/technician-report.dto';
import { SupportCaseActor } from './support-cases.service';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { RepairEvidence } from '../service-orders/entities/repair-evidence.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import {
  assertNoOnsiteInterruption, hasOnsiteInterruption, ONSITE_INTERRUPTION_ACTION,
  onsiteContinuationResult, onsiteInterruptionFingerprint, onsiteInterruptionRequest,
  validAssignmentCheckIn, verifiedOnsiteInterruption,
} from '../service-orders/onsite-interruption';

@Injectable()
export class TechnicianReportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
    private readonly reputation: ReputationService,
  ) {}

  /** T1 safe fallback: durable verified interruption, never synthetic cancellation or zero billing. */
  async cannotContinue(orderId: string, input: CannotContinueDto, actor: SupportCaseActor) {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    const request = onsiteInterruptionRequest(input);
    const fingerprint = onsiteInterruptionFingerprint(orderId, actor.id, request);
    try {
      return await this.dataSource.transaction(async manager => {
        // Authenticate before acquiring any business lock. Assignment is preserved
        // for original money/custody ownership and is checked again under the lock.
        const ref = await manager.findOneBy(ServiceOrder, { id: orderId });
        const owned = ref && await manager.findOneBy(TechnicianAssignment, {
          serviceOrderId: orderId, technicianId: actor.id, isActive: true,
        });
        if (!ref || !owned) throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
        const bookingRef = await manager.findOneBy(Booking, { id: ref.bookingId });
        if (!bookingRef) throw new ConflictException('Đơn không có lịch hẹn hợp lệ.');
        // Match the existing manager/group lock hierarchy: lead booking -> group
        // -> affected booking -> order -> assignment. No sibling outcome is written.
        if (bookingRef.visitGroupId) {
          const lead = await manager.findOne(VisitGroupItem, {
            where: { groupId: bookingRef.visitGroupId }, order: { sequence: 'ASC' },
          });
          if (!lead) throw new ConflictException('Không xác định được lượt sửa chữa.');
          await manager.findOne(Booking, { where: { id: lead.bookingId }, lock: { mode: 'pessimistic_write' } });
          const group = await manager.findOne(VisitGroup, {
            where: { id: bookingRef.visitGroupId, customerId: bookingRef.customerId }, lock: { mode: 'pessimistic_write' },
          });
          if (!group) throw new ConflictException('Lượt sửa chữa đã thay đổi.');
        }
        const booking = await manager.findOne(Booking, { where: { id: bookingRef.id }, lock: { mode: 'pessimistic_write' } });
        const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
        if (!booking || !order || order.bookingId !== booking.id || booking.visitGroupId !== bookingRef.visitGroupId) {
          throw new ConflictException('Thông tin đơn sửa chữa đã thay đổi.');
        }
        const assignments = await manager.find(TechnicianAssignment, {
          where: { serviceOrderId: order.id, isActive: true }, lock: { mode: 'pessimistic_write' },
        });
        const assignment = assignments[0];
        if (assignments.length !== 1 || assignment.technicianId !== actor.id || assignment.id !== owned.id) {
          throw new ConflictException('Kỹ thuật viên đang phụ trách đã thay đổi.');
        }
        if (await hasOnsiteInterruption(manager, order.id)) {
          const prior = await verifiedOnsiteInterruption(manager, order, booking);
          if (!prior || prior.incident.technicianId !== actor.id || prior.fingerprint !== fingerprint) {
            throw new ConflictException('Gián đoạn đã được ghi nhận với lệnh hoặc nội dung khác.');
          }
          return onsiteContinuationResult(order, booking, prior.incident.id);
        }
        if (booking.status !== BookingStatus.MATCHED ||
          ![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status)) {
          throw new ConflictException('Đơn không còn ở giai đoạn báo gián đoạn tại nhà khách.');
        }
        const checkins = await manager.find(ArrivalCheckIn, { where: {
          serviceOrderId: order.id, technicianId: actor.id, result: CheckInResult.VALID,
        }, order: { checkedInAt: 'DESC' } });
        const checkin = checkins.find(item => validAssignmentCheckIn(assignment, item));
        if (!checkin) throw new ConflictException('Cần check-in hợp lệ của lần phân công hiện tại tại nhà khách.');
        if (booking.visitGroupId) {
          const item = await manager.findOneBy(VisitGroupItem, { groupId: booking.visitGroupId, bookingId: booking.id });
          if (!item || item.outcome != null) throw new ConflictException('Thiết bị đã có kết quả hoặc không thuộc lượt sửa.');
        }
        const commandUsed = await manager.findOneBy(SupportCase, { interruptionCommandId: request.commandId });
        if (commandUsed) throw new ConflictException('Mã lệnh đã được dùng cho hồ sơ khác.');
        const photos = request.photoEvidenceIds.length ? await manager.find(RepairEvidence, { where: {
          id: In(request.photoEvidenceIds), serviceOrderId: order.id, uploaderId: actor.id, type: EvidenceType.ADDITIONAL,
        } }) : [];
        const prefix = `cloudinary://evidence/fixhome/evidence/${order.id}/${actor.id}/`;
        if (photos.length !== request.photoEvidenceIds.length || photos.some(photo =>
          !['image/jpeg', 'image/png', 'image/webp'].includes(photo.mimeType) ||
          !photo.mediaUrl?.startsWith(prefix) || !/^[a-zA-Z0-9-]+$/.test(photo.mediaUrl.slice(prefix.length)))) {
          throw new BadRequestException('Ảnh phải là ảnh riêng tư do bạn tải lên cho đơn này.');
        }
        const incident = await manager.save(SupportCase, manager.create(SupportCase, {
          caseType: SupportCaseType.TECHNICIAN_REPLACEMENT, status: SupportCaseStatus.OPEN,
          bookingId: booking.id, serviceOrderId: order.id, customerId: booking.customerId,
          technicianId: actor.id, createdByUserId: actor.id, assignedManagerId: null,
          reason: request.reason, description: null, evidenceRefs: request.photoEvidenceIds,
          reasonClass: request.reasonClass, reasonCode: request.reasonCode,
          responsibility: TechnicianResponsibility.PENDING,
          isUrgent: true, respondBy: respondByFor(order.status, true), holdCompletion: true, workflowVersion: 0,
          interruptionCommandId: request.commandId, interruptionFingerprint: fingerprint,
        }));
        // The strict receipt is the independent authority, not the mutable SM
        // status/hold. Retain assignment and every quote/payment/part unchanged.
        await this.auditLog.logWithManagerStrict(manager, {
          actorUserId: actor.id, actorRole: actor.role, action: ONSITE_INTERRUPTION_ACTION,
          resourceType: 'service_order', resourceId: order.id,
          after: { version: 1, serviceOutcome: 'VERIFIED_INTERRUPTION_RECORDED',
            incidentId: incident.id, sourceBookingId: booking.id, customerId: booking.customerId,
            sourceVisitGroupId: booking.visitGroupId ?? null, serviceOrderStatus: order.status,
            assignmentId: assignment.id, checkInId: checkin.id, fingerprint, request },
        });
        const staff = await manager.find(User, { where: {
          role: In([Role.SERVICE_MANAGER, Role.ADMIN]), status: AccountStatus.ACTIVE, isActive: true,
        }, select: { id: true } });
        await manager.insert(Notification, [
          { userId: booking.customerId, title: 'Đã ghi nhận gián đoạn sửa chữa',
            message: 'Bạn có thể tự đặt lịch mới. Báo giá, thanh toán và linh kiện của đơn cũ được giữ để đối soát riêng.',
            type: ONSITE_INTERRUPTION_ACTION, referenceType: 'SUPPORT_CASE', referenceId: incident.id, isRead: false },
          ...staff.map(user => ({ userId: user.id, title: 'Gián đoạn sửa chữa cần đối soát',
            message: 'Đã ghi nhận kỹ thuật viên không thể tiếp tục tại nhà khách. Kiểm tra nghĩa vụ đơn cũ; trả linh kiện vẫn cần quản lý xác nhận thực nhận.',
            type: ONSITE_INTERRUPTION_ACTION, referenceType: 'SUPPORT_CASE', referenceId: incident.id, isRead: false })),
        ]);
        return onsiteContinuationResult(order, booking, incident.id);
      });
    } catch (error) {
      // The existing unique command index serializes cross-order UUID reuse.
      if ((error as { code?: string })?.code === '23505') throw new ConflictException('Mã lệnh đã được sử dụng.');
      throw error;
    }
  }

  async customerContinuation(orderId: string, actor: SupportCaseActor) {
    if (actor.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    // A consistent read under the same business locks; never creates a Booking.
    return this.dataSource.transaction(async manager => {
      const ref = await manager.findOneBy(ServiceOrder, { id: orderId });
      const owned = ref && await manager.findOneBy(Booking, { id: ref.bookingId, customerId: actor.id });
      if (!ref || !owned) throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
      const booking = await manager.findOne(Booking, { where: { id: owned.id, customerId: actor.id }, lock: { mode: 'pessimistic_read' } });
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_read' } });
      if (!booking || !order || order.bookingId !== booking.id) throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
      const proof = await verifiedOnsiteInterruption(manager, order, booking);
      return onsiteContinuationResult(order, booking, proof?.incident.id ?? null);
    });
  }

  async report(input: TechnicianReportDto, actor: SupportCaseActor): Promise<SupportCase> {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    if (input.intent != null && input.intent !== 'REPORT_ONLY') throw new BadRequestException('Báo cáo này chỉ ghi nhận thông tin.');
    if (!reasonMatchesClass(input.reasonClass, input.reasonCode)) {
      throw new BadRequestException('Loại và lý do báo cáo không khớp.');
    }
    const reason = input.reason.trim();
    const evidenceRefs = input.evidenceRefs ?? [];
    return this.dataSource.transaction(async manager => {
      const order = await manager.findOne(ServiceOrder, {
        where: { id: input.serviceOrderId }, lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
      const assignment = await manager.findOne(TechnicianAssignment, { where: {
        serviceOrderId: order.id, technicianId: actor.id, isActive: true,
      } });
      if (!assignment || assignment.technicianId !== actor.id || !assignment.isActive) {
        throw new NotFoundException('Không tìm thấy đơn sửa chữa.');
      }
      await assertNoOnsiteInterruption(manager, order.id);
      if (![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status)) {
        throw new ConflictException('Đơn không còn ở giai đoạn báo khó khăn sửa chữa.');
      }
      const checkedIn = await manager.query(
        `SELECT id FROM arrival_check_ins WHERE service_order_id = $1 AND technician_id = $2 AND result = 'valid' LIMIT 1`,
        [order.id, actor.id],
      );
      if (!checkedIn.length) throw new ConflictException('Chỉ báo sau khi đã check-in tại nhà khách.');
      const existing = await manager.findOne(SupportCase, { where: {
        serviceOrderId: order.id, technicianId: actor.id,
        responsibility: TechnicianResponsibility.PENDING,
        reasonClass: In(['technician_skill_gap', 'non_technician_exception']),
      } });
      if (existing) {
        if (existing.reasonClass === input.reasonClass && existing.reasonCode === input.reasonCode &&
            existing.reason === reason && JSON.stringify(existing.evidenceRefs ?? []) === JSON.stringify(evidenceRefs)) return existing;
        throw new ConflictException('Đã có báo cáo đang chờ quản lý xem xét.');
      }
      const booking = await manager.findOne(Booking, { where: { id: order.bookingId } });
      if (!booking) throw new ConflictException('Đơn không có lịch hẹn hợp lệ.');
      const report = await manager.save(SupportCase, manager.create(SupportCase, {
        caseType: SupportCaseType.TECHNICIAN_REPLACEMENT,
        status: SupportCaseStatus.OPEN,
        bookingId: booking.id,
        serviceOrderId: order.id,
        customerId: booking.customerId,
        technicianId: actor.id,
        createdByUserId: actor.id,
        assignedManagerId: null,
        reason,
        description: null,
        evidenceRefs,
        reasonClass: input.reasonClass,
        reasonCode: input.reasonCode,
        responsibility: TechnicianResponsibility.PENDING,
        responsibilityCommandId: null,
        responsibilityActorId: null,
        responsibilityReason: null,
        responsibilityEvidenceRefs: null,
        responsibilityDecidedAt: null,
        isUrgent: true,
        respondBy: respondByFor(order.status, true),
        holdCompletion: false,
        workflowVersion: 0,
      }));
      await this.auditLog.logWithManagerStrict(manager, { actorUserId: actor.id, actorRole: actor.role,
        action: 'TECHNICIAN_EXCEPTION_REPORTED', resourceType: 'support_case', resourceId: report.id,
        after: { serviceOrderId: order.id, reasonClass: input.reasonClass, reasonCode: input.reasonCode } });
      const managers = await manager.find(User, { where: {
        role: In([Role.SERVICE_MANAGER, Role.ADMIN]), status: AccountStatus.ACTIVE, isActive: true,
      }, select: { id: true } });
      const notifications = [booking.customerId, ...managers.map(managerUser => managerUser.id)].map(userId => ({
        userId, title: 'Báo cáo sửa chữa cần xem xét',
        message: 'Kỹ thuật viên đã báo tình huống cần quản lý dịch vụ xem xét. Chưa có quyết định về trách nhiệm hoặc điểm uy tín.',
        type: 'TECHNICIAN_EXCEPTION_REPORTED', referenceType: 'SUPPORT_CASE', referenceId: report.id,
        isRead: false,
      }));
      await manager.insert(Notification, notifications);
      return report;
    });
  }

  async decide(caseId: string, input: DecideTechnicianResponsibilityDto, actor: SupportCaseActor): Promise<SupportCase> {
    if (![Role.SERVICE_MANAGER, Role.ADMIN].includes(actor.role as Role)) throw new ForbiddenException('Manager role required');
    if (input.decision === TechnicianResponsibility.PENDING || !Object.values(TechnicianResponsibility).includes(input.decision)) {
      throw new BadRequestException('Quyết định trách nhiệm không hợp lệ.');
    }
    const reason = input.reason.trim();
    const evidenceRefs = input.evidenceRefs ?? [];
    return this.dataSource.transaction(async manager => {
      const report = await manager.findOne(SupportCase, { where: { id: caseId }, lock: { mode: 'pessimistic_write' } });
      if (!report || !report.reasonClass || !report.technicianId ||
          report.caseType !== SupportCaseType.TECHNICIAN_REPLACEMENT) {
        throw new NotFoundException('Không tìm thấy báo cáo cần đánh giá.');
      }
      if (report.responsibility !== TechnicianResponsibility.PENDING) {
        if (report.responsibilityCommandId === input.commandId && report.responsibilityActorId === actor.id &&
            report.responsibility === input.decision && report.responsibilityReason === reason &&
            JSON.stringify(report.responsibilityEvidenceRefs ?? []) === JSON.stringify(evidenceRefs) &&
            report.workflowVersion === input.workflowVersion + 1) return report;
        throw new ConflictException('Trách nhiệm đã được quyết định.');
      }
      if (report.workflowVersion !== input.workflowVersion) throw new ConflictException('Báo cáo đã thay đổi; vui lòng tải lại.');
      if (input.decision === TechnicianResponsibility.TECHNICIAN_FAULT) {
        await this.reputation.penalizeReviewedCase(manager, {
          caseId: report.id, technicianId: report.technicianId,
          serviceOrderId: report.serviceOrderId, actorId: actor.id, reason,
        });
      }
      report.responsibility = input.decision;
      report.responsibilityCommandId = input.commandId;
      report.responsibilityActorId = actor.id;
      report.responsibilityReason = reason;
      report.responsibilityEvidenceRefs = evidenceRefs;
      report.responsibilityDecidedAt = new Date();
      report.workflowVersion += 1;
      const saved = await manager.save(SupportCase, report);
      await this.auditLog.logWithManagerStrict(manager, { actorUserId: actor.id, actorRole: actor.role,
        action: 'TECHNICIAN_RESPONSIBILITY_DECIDED', resourceType: 'support_case', resourceId: report.id,
        after: { decision: input.decision, reason, evidenceRefs, serviceOrderId: report.serviceOrderId } });
      await manager.insert(Notification, { userId: report.technicianId,
        title: 'Đã có kết quả xem xét báo cáo',
        message: input.decision === TechnicianResponsibility.TECHNICIAN_FAULT
          ? 'Quản lý đã xác định trách nhiệm của bạn và cập nhật điểm uy tín. Vui lòng xem chi tiết.'
          : 'Quản lý đã xem xét tình huống và ghi nhận kết quả trách nhiệm. Vui lòng xem chi tiết.',
        type: 'TECHNICIAN_RESPONSIBILITY_DECIDED', referenceType: 'SUPPORT_CASE', referenceId: report.id, isRead: false });
      return saved;
    });
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AccountStatus, Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
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
  DecideTechnicianResponsibilityDto, reasonMatchesClass, TechnicianReportDto,
  TechnicianResponsibility,
} from './dto/technician-report.dto';
import { SupportCaseActor } from './support-cases.service';

@Injectable()
export class TechnicianReportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
    private readonly reputation: ReputationService,
  ) {}

  async report(input: TechnicianReportDto, actor: SupportCaseActor): Promise<SupportCase> {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
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

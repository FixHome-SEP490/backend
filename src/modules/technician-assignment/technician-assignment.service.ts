// src/modules/technician-assignment/technician-assignment.service.ts
import { newOrderCode } from '../service-orders/order-code';
import { Injectable, Logger, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ServiceOrderStatus, BookingStatus, InvitationStatus, QuotationStatus, Role, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { technicianEligibility } from '../bookings/technician-eligibility';
import { releaseOutgoingTechnicianPartRequests } from '../part-requests/part-request-lifecycle';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MessagingService } from '../messaging/messaging.service';
import { AcceptGreetingPublisher } from '../messaging/accept-greeting.publisher';
import { NotificationsService } from '../notifications/notifications.service';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';

@Injectable()
export class TechnicianAssignmentService {
  private readonly logger = new Logger(TechnicianAssignmentService.name);

  constructor(
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly messagingService: MessagingService,
    @Optional() private readonly acceptGreeting?: AcceptGreetingPublisher,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /**
   * SM/Admin manually assigns a technician to a Booking that has exhausted
   * (or never used) sequential shortlist invitations and has no active
   * ServiceOrder yet. Mirrors InvitationsService.respond()'s ServiceOrder
   * creation so the resulting order/chat state is indistinguishable from a
   * normal Accept.
   */
  async assignToBooking(
    bookingId: string,
    technicianId: string,
    actorUser: { id: string; role: string },
    reason?: string,
  ): Promise<{ booking: Booking; serviceOrder: ServiceOrder; assignment: TechnicianAssignment }> {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actorUser.role as Role)) throw new ForbiddenException('Staff assignment permission required');
    if (!reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Assignment reason is required');
    const result = await this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, { where: { id: bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!booking) throw new NotFoundException('Booking not found');
      if (![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.CLOSED].includes(booking.status)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking is not open for manual assignment');
      const existingOrder = await manager.findOneBy(ServiceOrder, { bookingId });
      if (existingOrder && (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(existingOrder.status) || await manager.count(TechnicianAssignment, { where: { serviceOrderId: existingOrder.id, isActive: true } }))) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking already has an active technician');
      // Serialises with the technician's own Accept, so two bookings cannot both take the same slot.
      await manager.findOne(User, { where: { id: technicianId }, lock: { mode: 'pessimistic_write' } });
      const eligibility = await technicianEligibility(manager, technicianId, booking);
      if (!eligibility.eligible) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, eligibility.reason!);

      const now = new Date();
      const code = existingOrder?.code ?? newOrderCode(now);
      const serviceOrder = existingOrder ?? await manager.save(ServiceOrder, manager.create(ServiceOrder, { bookingId: booking.id, code, status: ServiceOrderStatus.ACCEPTED, scheduledAt: booking.preferredStartAt }));
      const assignment = await manager.save(TechnicianAssignment, manager.create(TechnicianAssignment, { serviceOrderId: serviceOrder.id, technicianId, isActive: true, assignedAt: now }));
      if (existingOrder) await manager.update(ServiceOrder, serviceOrder.id, { departureWarnedAt: null });
      await manager.insert(OrderStatusHistory, { serviceOrderId: serviceOrder.id, fromStatus: existingOrder ? serviceOrder.status : null, toStatus: serviceOrder.status, actorUserId: actorUser.id, actorRole: actorUser.role, reason });

      await manager.createQueryBuilder().update(BookingInvitation).set({ status: InvitationStatus.CANCELLED, respondedAt: now }).where('booking_id = :bookingId AND status IN (:...statuses)', { bookingId, statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY] }).execute();
      await manager.update(Booking, booking.id, { status: BookingStatus.MATCHED });

      await this.messagingService.ensureConversation(manager, booking, technicianId);
      await this.messagingService.attachToServiceOrder(manager, booking.id, technicianId, serviceOrder.id);

      await this.auditLogService.logWithManager(manager, {
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        action: 'TECHNICIAN_MANUAL_ASSIGN',
        resourceType: 'booking',
        resourceId: bookingId,
        after: { serviceOrderId: serviceOrder.id, technicianId, reason },
      });

      this.logger.log(`Technician ${technicianId} manually assigned to booking ${bookingId} by ${actorUser.id}`);

      return { booking, serviceOrder, assignment };
    });
    // After commit, as on a technician's own accept.
    await this.acceptGreeting?.send({ bookingId, technicianId, serviceOrderId: result.serviceOrder.id, orderCode: result.serviceOrder.code });
    return result;
  }

  /**
   * SM/Admin replaces the technician of an order before departure. The result
   * must look like that technician accepted the booking themselves: booking
   * MATCHED with no invitation left open, the new technician's chat attached to
   * the order (the previous technician's thread turns read-only), the greeting
   * sent, and the previous technician's unpicked part requests released.
   * P4.5: POST /technicians/:id/assign
   */
  async overrideAssign(
    technicianId: string,
    orderId: string,
    actorUser: { id: string; role: string },
    reason?: string,
  ): Promise<TechnicianAssignment> {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actorUser.role as Role)) throw new ForbiddenException('Staff assignment permission required');
    if (!reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Assignment reason is required');
    const ref = await this.orderRepo.findOneBy({ id: orderId });
    if (!ref) throw new NotFoundException('Service order not found');
    const result = await this.dataSource.transaction(async (manager) => {
      // Booking first, then order, then technician: the order every matching command uses.
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!booking || !order) throw new NotFoundException('Service order not found');
      // Mid-job replacement needs the DEV2 financial/manual resolution workflow.
      if (order.status !== ServiceOrderStatus.ACCEPTED) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Only pre-departure reassignment is supported; later replacement requires manual resolution');
      await manager.findOne(User, { where: { id: technicianId }, lock: { mode: 'pessimistic_write' } });
      const existingAssignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: orderId, isActive: true },
      });
      if (existingAssignment?.technicianId === technicianId) throw new BusinessException(ErrorCodes.CONFLICT, 'Technician already holds this order');
      const eligibility = await technicianEligibility(manager, technicianId, booking, orderId);
      if (!eligibility.eligible) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, eligibility.reason!);
      const now = new Date();

      if (existingAssignment) {
        existingAssignment.isActive = false;
        existingAssignment.unassignedAt = now;
        existingAssignment.unassignReason = reason;
        await manager.save(existingAssignment);
        await releaseOutgoingTechnicianPartRequests(manager, orderId, existingAssignment.technicianId);
      }

      await manager.update(ServiceOrder, orderId, { departureWarnedAt: null });
      const savedAssignment = await manager.save(manager.create(TechnicianAssignment, {
        serviceOrderId: orderId,
        technicianId,
        isActive: true,
        assignedAt: now,
      }));

      await manager.createQueryBuilder().update(BookingInvitation).set({ status: InvitationStatus.CANCELLED, respondedAt: now }).where('booking_id = :bookingId AND status IN (:...statuses)', { bookingId: booking.id, statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY] }).execute();
      if (booking.status !== BookingStatus.MATCHED) await manager.update(Booking, booking.id, { status: BookingStatus.MATCHED });
      await this.messagingService.ensureConversation(manager, booking, technicianId);
      await this.messagingService.attachToServiceOrder(manager, booking.id, technicianId, orderId);

      await manager.save(manager.create(OrderStatusHistory, {
        serviceOrderId: orderId,
        fromStatus: order.status,
        toStatus: order.status,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        reason,
      }));
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        action: 'TECHNICIAN_OVERRIDE_ASSIGNED',
        resourceType: 'service_orders',
        resourceId: orderId,
        after: {
          technicianId,
          previousTechnicianId: existingAssignment?.technicianId || null,
          reason,
        },
      });

      this.logger.log(`Technician ${technicianId} assigned to order ${orderId} by ${actorUser.id}`);
      return { assignment: savedAssignment, bookingId: booking.id, orderCode: order.code };
    });
    await this.acceptGreeting?.send({ bookingId: result.bookingId, technicianId, serviceOrderId: orderId, orderCode: result.orderCode });
    return result.assignment;
  }

  /**
   * The technician on site reported "Cần thay đổi thợ" (PO 08/10/2026): a
   * Service Manager hands the order to another technician. The order goes back
   * to ACCEPTED so the new technician sets out and checks in themselves (a
   * check-in belongs to the technician who made it); the reporting technician
   * leaves without a cancellation, so no reputation points are taken. Refused
   * once money is tied to the first technician's work: an approved quotation
   * or an invoice. A quotation still waiting for the customer is superseded.
   */
  async replaceAfterReport(
    orderId: string,
    technicianId: string,
    actorUser: { id: string; role: string },
    reason: string,
  ): Promise<{ orderId: string; technicianId: string; previousTechnicianId: string | null }> {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actorUser.role as Role)) throw new ForbiddenException('Staff assignment permission required');
    if (!reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Ghi lý do đổi thợ');
    const ref = await this.orderRepo.findOneBy({ id: orderId });
    if (!ref) throw new NotFoundException('Service order not found');
    const result = await this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!booking || !order) throw new NotFoundException('Service order not found');
      if (![ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR].includes(order.status)) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chỉ đổi thợ khi đơn đang đi hoặc đang sửa');
      }
      const cases = await manager.find(SupportCase, {
        where: { serviceOrderId: orderId, caseType: SupportCaseType.TECHNICIAN_REPLACEMENT, status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cases.length) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn không có yêu cầu đổi thợ đang mở');
      if (await manager.count(Quotation, { where: { serviceOrderId: orderId, status: QuotationStatus.APPROVED } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Khách đã duyệt báo giá của thợ hiện tại, không đổi thợ được; hãy huỷ đơn không trừ điểm');
      }
      if (await manager.count(Invoice, { where: { serviceOrderId: orderId } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đã có hoá đơn, không đổi thợ được');
      }
      await manager.findOne(User, { where: { id: technicianId }, lock: { mode: 'pessimistic_write' } });
      const current = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: orderId, isActive: true } });
      if (current?.technicianId === technicianId) throw new BusinessException(ErrorCodes.CONFLICT, 'Kỹ thuật viên này đang giữ đơn');
      const eligibility = await technicianEligibility(manager, technicianId, booking, orderId);
      if (!eligibility.eligible) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, eligibility.reason!);
      const now = new Date();
      if (current) {
        current.isActive = false;
        current.unassignedAt = now;
        current.unassignReason = `Đổi thợ theo yêu cầu: ${reason.trim()}`;
        await manager.save(current);
        await releaseOutgoingTechnicianPartRequests(manager, orderId, current.technicianId);
      }
      await manager.update(Quotation, { serviceOrderId: orderId, status: In([QuotationStatus.DRAFT, QuotationStatus.SENT]) }, { status: QuotationStatus.SUPERSEDED });
      await manager.update(ServiceOrder, orderId, { status: ServiceOrderStatus.ACCEPTED, departureWarnedAt: null });
      await manager.save(manager.create(TechnicianAssignment, { serviceOrderId: orderId, technicianId, isActive: true, assignedAt: now }));
      await this.messagingService.ensureConversation(manager, booking, technicianId);
      await this.messagingService.attachToServiceOrder(manager, booking.id, technicianId, orderId);
      await manager.save(manager.create(OrderStatusHistory, {
        serviceOrderId: orderId,
        fromStatus: order.status,
        toStatus: ServiceOrderStatus.ACCEPTED,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        reason: `Đổi thợ sau khi thợ báo cần thay: ${reason.trim()}`,
      }));
      for (const c of cases) {
        await manager.update(SupportCase, c.id, {
          status: SupportCaseStatus.RESOLVED,
          resolutionCode: 'worker_reassigned',
          resolutionReason: reason.trim(),
          assignedManagerId: c.assignedManagerId ?? actorUser.id,
          resolvedAt: now,
          holdCompletion: false,
        });
      }
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        action: 'TECHNICIAN_REPLACED_AFTER_REPORT',
        resourceType: 'service_orders',
        resourceId: orderId,
        before: { status: order.status, technicianId: current?.technicianId ?? null },
        after: { status: ServiceOrderStatus.ACCEPTED, technicianId, reason: reason.trim(), resolvedCases: cases.map((c) => c.id) },
      });
      return { customerId: booking.customerId, code: order.code, previous: current?.technicianId ?? null };
    });
    if (this.notificationsService) {
      const notes = [
        { userId: technicianId, title: 'Bạn được giao một đơn', message: `Quản lý giao cho bạn đơn #${result.code} thay kỹ thuật viên trước. Vui lòng xem đơn và xuất phát.` },
        ...(result.customerId ? [{ userId: result.customerId, title: 'Đơn của bạn đổi kỹ thuật viên', message: `Đơn #${result.code} đã được giao cho kỹ thuật viên khác phù hợp hơn. Thợ mới sẽ liên hệ và tới nơi.` }] : []),
        ...(result.previous ? [{ userId: result.previous, title: 'Đã đổi thợ cho đơn', message: `Quản lý đã giao đơn #${result.code} cho kỹ thuật viên khác theo báo cáo của bạn. Bạn không bị trừ điểm uy tín.` }] : []),
      ];
      await this.notificationsService.createManyNotifications(notes.map((n) => ({ ...n, type: 'TECHNICIAN_REPLACED', referenceId: orderId, referenceType: 'SERVICE_ORDER' }))).catch(() => undefined);
    }
    await this.acceptGreeting?.send({ bookingId: ref.bookingId, technicianId, serviceOrderId: orderId, orderCode: result.code });
    return { orderId, technicianId, previousTechnicianId: result.previous };
  }
}

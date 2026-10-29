// src/modules/technician-assignment/technician-assignment.service.ts
import { snapshotLaborWarranty } from '../service-orders/labor-warranty';
import { createHash } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { newOrderCode } from '../service-orders/order-code';
import { Injectable, Logger, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ServiceOrderStatus, BookingStatus, InvitationStatus, QuotationStatus, Role, SupportCaseStatus, SupportCaseType, PaymentStatus, PartRequestStatus, CancelActor, CompensationStatus, AdditionalCostStatus } from '../../shared/enums';
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
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { VoucherReservation } from '../vouchers/entities/voucher.entity';
import { VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { Cancellation } from '../service-orders/entities/cancellation.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ServiceOrderStateMachine } from '../service-orders/service-order-state-machine';
import { closeBookingForCancelledOrder } from '../service-orders/close-cancelled-booking';
import { InterruptionAction, ResolveInterruptionDto } from './resolve-interruption.dto';
import { EntityManager } from 'typeorm';

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

  private async interruptionOptions(manager: EntityManager, supportCase: SupportCase, booking: Booking, order: ServiceOrder) {
    const scopeId = booking.visitGroupId ?? order.id;
    const activeAssignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true } });
    const assignmentChanged = !activeAssignment || activeAssignment.technicianId !== supportCase.technicianId;
    const approvedQuote = await manager.count(Quotation, { where: { serviceOrderId: order.id, status: QuotationStatus.APPROVED } }) > 0
      || await manager.count(AdditionalCostRequest, { where: { serviceOrderId: order.id, status: AdditionalCostStatus.APPROVED } }) > 0;
    const openQuote = await manager.count(Quotation, { where: { serviceOrderId: order.id,
      status: In([QuotationStatus.DRAFT, QuotationStatus.SENT]) } }) > 0;
    const invoice = !!await manager.findOne(Invoice, { where: { serviceOrderId: order.id } });
    const cash = !!await manager.findOne(CashSettlement, { where: { serviceOrderId: order.id } });
    const voucher = !!await manager.findOne(VoucherReservation, { where: { scopeId } })
      || !!await manager.findOne(VoucherPaymentLink, { where: { scopeId } });
    const parts = await manager.count(PartRequest, { where: { serviceOrderId: order.id, status: In([
      PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING,
      PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED,
    ]) } }) > 0;
    const groupPayment = booking.visitGroupId
      ? !!await manager.findOne(VisitGroupPayment, { where: { visitGroupId: booking.visitGroupId } }) : false;
    const payment = cash || groupPayment || order.paymentStatus !== PaymentStatus.UNPAID;
    const incompleteSiblings = booking.visitGroupId
      ? await manager.count(VisitGroupItem, { where: { groupId: booking.visitGroupId, outcome: null } }) > 1 : false;
    const conflictingCase = await manager.count(SupportCase, { where: [
      { serviceOrderId: order.id, id: Not(supportCase.id), requestIntent: 'stop_or_replace', status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]) },
      { serviceOrderId: order.id, id: Not(supportCase.id), caseType: SupportCaseType.TECHNICIAN_REPLACEMENT, status: In([SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW]) },
    ] }) > 0;
    const flags = { approvedQuote, openQuote, invoice, payment, voucher, parts, incompleteSiblings, assignmentChanged, conflictingCase };
    const active = [SupportCaseStatus.OPEN, SupportCaseStatus.IN_REVIEW].includes(supportCase.status)
      && (supportCase.caseType === SupportCaseType.TECHNICIAN_REPLACEMENT || supportCase.requestIntent === 'stop_or_replace');
    const phaseAllowed = order.status === ServiceOrderStatus.UNDER_REPAIR
      || (supportCase.caseType === SupportCaseType.TECHNICIAN_REPLACEMENT
        && supportCase.requestIntent !== 'stop_or_replace' && order.status === ServiceOrderStatus.EN_ROUTE);
    const common = [
      ...(!active ? ['CASE_NOT_ACTIVE'] : []),
      ...(!phaseAllowed ? ['ORDER_NOT_UNDER_REPAIR'] : []),
      ...(order.completionRequestedAt ? ['COMPLETION_REQUESTED'] : []),
      ...(assignmentChanged ? ['ASSIGNMENT_CHANGED'] : []),
      ...(conflictingCase ? ['CONFLICTING_CASE'] : []),
      ...(invoice ? ['INVOICE_EXISTS'] : []),
      ...(payment ? ['PAYMENT_EXPOSURE'] : []),
      ...(voucher ? ['VOUCHER_EXPOSURE'] : []),
      ...(parts ? ['PARTS_CUSTODY_REVIEW'] : []),
      ...(approvedQuote ? ['APPROVED_QUOTE'] : []),
    ];
    const direct = [...common, ...(booking.visitGroupId ? ['VISIT_GROUP_CHILD'] : [])];
    const close = [...common, ...(openQuote ? ['OPEN_QUOTE'] : [])];
    return { caseId: supportCase.id, caseStatus: supportCase.status, caseVersion: supportCase.workflowVersion,
      serviceOrderId: order.id, visitGroupId: booking.visitGroupId ?? null, requestIntent: supportCase.requestIntent ?? null,
      flags, actions: {
        DIRECT_REASSIGN_SOLO: { allowed: direct.length === 0, reasons: direct },
        CLOSE_FOR_REBOOK: { allowed: close.length === 0, reasons: close },
        REJECT_REQUEST: { allowed: active, reasons: active ? [] : ['CASE_NOT_ACTIVE'] },
      } };
  }

  async replacementOptions(caseId: string, actor: { id: string; role: string }) {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    const manager = this.dataSource.manager;
    const supportCase = await manager.findOne(SupportCase, { where: { id: caseId } });
    if (!supportCase?.serviceOrderId) throw new NotFoundException('Support case not found');
    const order = await manager.findOne(ServiceOrder, { where: { id: supportCase.serviceOrderId } });
    const booking = order && await manager.findOne(Booking, { where: { id: order.bookingId } });
    if (!order || !booking) throw new ConflictException('Support case order is unavailable');
    if ((supportCase.bookingId != null && supportCase.bookingId !== booking.id) || supportCase.customerId !== booking.customerId) {
      throw new ConflictException('Support case context changed');
    }
    return this.interruptionOptions(manager, supportCase, booking, order);
  }

  async resolveInterruption(caseId: string, dto: ResolveInterruptionDto, actor: { id: string; role: string }) {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    if (!Object.values(InterruptionAction).includes(dto.action) || !dto.reason?.trim() || dto.reason.trim().length < 10 || dto.reason.length > 2000) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Lệnh xử lý không hợp lệ.');
    }
    if ((dto.action === InterruptionAction.DIRECT_REASSIGN_SOLO) !== !!dto.technicianId) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'technicianId chỉ được gửi khi đổi thợ trực tiếp.');
    }
    const normalized = { action: dto.action, reason: dto.reason.trim(), technicianId: dto.technicianId ?? null };
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    let sendGreeting: { bookingId: string; technicianId: string; serviceOrderId: string; orderCode: string } | null = null;
    const result = await this.dataSource.transaction(async manager => {
      const reference = await manager.findOne(SupportCase, { where: { id: caseId } });
      if (!reference?.serviceOrderId) throw new NotFoundException('Support case not found');
      const orderReference = await manager.findOne(ServiceOrder, { where: { id: reference.serviceOrderId } });
      if (!orderReference) throw new ConflictException('Support case order is unavailable');
      const bookingReference = await manager.findOne(Booking, { where: { id: orderReference.bookingId } });
      if (!bookingReference) throw new ConflictException('Support case booking is unavailable');
      if (bookingReference.visitGroupId) {
        const lead = await manager.findOne(VisitGroupItem, { where: { groupId: bookingReference.visitGroupId }, order: { sequence: 'ASC' } });
        if (!lead) throw new ConflictException('VisitGroup lead is unavailable');
        await manager.findOne(Booking, { where: { id: lead.bookingId }, lock: { mode: 'pessimistic_write' } });
        await manager.findOne(VisitGroup, { where: { id: bookingReference.visitGroupId }, lock: { mode: 'pessimistic_write' } });
      }
      const booking = await manager.findOne(Booking, { where: { id: bookingReference.id }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOne(ServiceOrder, { where: { id: orderReference.id }, lock: { mode: 'pessimistic_write' } });
      const supportCase = await manager.findOne(SupportCase, { where: { id: caseId }, lock: { mode: 'pessimistic_write' } });
      if (!booking || !order || !supportCase || supportCase.serviceOrderId !== order.id || order.bookingId !== booking.id
        || (supportCase.bookingId != null && supportCase.bookingId !== booking.id) || supportCase.customerId !== booking.customerId) {
        throw new ConflictException('Support case context changed');
      }
      if (supportCase.interruptionCommandId) {
        if (supportCase.interruptionCommandId !== dto.commandId || supportCase.interruptionFingerprint !== fingerprint) {
          throw new ConflictException('Support case was handled by another command');
        }
        return { case: this.interruptionCaseResult(supportCase), order: { id: order.id, status: order.status },
          nextAction: supportCase.resolutionCode === 'interrupted_for_rebook' ? 'interruption_rebook' as const : 'none' as const };
      }
      if (supportCase.workflowVersion !== dto.expectedCaseVersion) throw new ConflictException('Support case version changed');
      const options = await this.interruptionOptions(manager, supportCase, booking, order);
      const decision = options.actions[dto.action];
      if (!decision.allowed) {
        const explanations: Record<string, string> = {
          CASE_NOT_ACTIVE: 'hồ sơ không còn mở', ORDER_NOT_UNDER_REPAIR: 'đơn không còn đang sửa',
          COMPLETION_REQUESTED: 'thợ đã yêu cầu hoàn tất', INVOICE_EXISTS: 'đã có hóa đơn',
          ASSIGNMENT_CHANGED: 'kỹ thuật viên đang phụ trách đã thay đổi',
          CONFLICTING_CASE: 'còn yêu cầu dừng sửa hoặc đổi thợ khác đang mở',
          PAYMENT_EXPOSURE: 'có trạng thái thanh toán cần đối soát', VOUCHER_EXPOSURE: 'có ưu đãi cần đối soát',
          PARTS_CUSTODY_REVIEW: 'có linh kiện cần đối soát', VISIT_GROUP_CHILD: 'không đổi thợ riêng một thiết bị trong lượt sửa',
          APPROVED_QUOTE: 'khách đã duyệt báo giá hoặc chi phí phát sinh',
          OPEN_QUOTE: 'còn báo giá đang soạn hoặc chờ khách duyệt',
        };
        throw new ConflictException(`Không thể xử lý yêu cầu: ${decision.reasons.map(reason => explanations[reason] ?? reason).join('; ')}.`);
      }
      const now = new Date();
      const current = dto.action === InterruptionAction.REJECT_REQUEST ? null
        : await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true }, lock: { mode: 'pessimistic_write' } });
      if (dto.action !== InterruptionAction.REJECT_REQUEST && !current) throw new ConflictException('Order has no active technician');
      if (current && current.technicianId !== supportCase.technicianId) throw new ConflictException('Kỹ thuật viên đang phụ trách đã thay đổi.');
      if (dto.action === InterruptionAction.DIRECT_REASSIGN_SOLO) {
        if (!ServiceOrderStateMachine.canResetAfterManagerInterruption(order.status)) throw new ConflictException('Order cannot be reset');
        if (current!.technicianId === dto.technicianId) throw new ConflictException('Technician already holds this order');
        const user = await manager.findOne(User, { where: { id: dto.technicianId }, lock: { mode: 'pessimistic_write' } });
        if (!user) throw new ConflictException('Technician unavailable');
        const eligibility = await technicianEligibility(manager, dto.technicianId!, booking, order.id);
        if (!eligibility.eligible) throw new ConflictException(eligibility.reason ?? 'Technician unavailable');
        await manager.update(TechnicianAssignment, current!.id, { isActive: false, unassignedAt: now, unassignReason: normalized.reason });
        await manager.update(Quotation, { serviceOrderId: order.id, status: In([QuotationStatus.DRAFT, QuotationStatus.SENT]) }, { status: QuotationStatus.SUPERSEDED });
        await manager.update(ServiceOrder, order.id, { status: ServiceOrderStatus.ACCEPTED, departureWarnedAt: null, completionRequestedAt: null });
        await manager.save(TechnicianAssignment, manager.create(TechnicianAssignment, { serviceOrderId: order.id, technicianId: dto.technicianId, isActive: true, assignedAt: now }));
        await snapshotLaborWarranty(manager, order.id, dto.technicianId!, booking.serviceId);
        await this.messagingService.ensureConversation(manager, booking, dto.technicianId!);
        await this.messagingService.attachToServiceOrder(manager, booking.id, dto.technicianId!, order.id);
        sendGreeting = { bookingId: booking.id, technicianId: dto.technicianId!, serviceOrderId: order.id, orderCode: order.code };
      } else if (dto.action === InterruptionAction.CLOSE_FOR_REBOOK) {
        if (!ServiceOrderStateMachine.canTransition(order.status, ServiceOrderStatus.CANCELLED, Role.SERVICE_MANAGER)) throw new ConflictException('Order cannot be closed');
        await manager.update(ServiceOrder, order.id, { status: ServiceOrderStatus.CANCELLED, laborTotal: 0, partsTotal: 0, grandTotal: 0 });
        await manager.update(AdditionalCostRequest, { serviceOrderId: order.id, status: AdditionalCostStatus.PENDING_APPROVAL },
          { status: AdditionalCostStatus.CANCELLED, decidedAt: now });
        await closeBookingForCancelledOrder(manager, booking.id);
        await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: order.id,
          actor: CancelActor.SERVICE_MANAGER, actorUserId: actor.id, reason: normalized.reason,
          stateAtCancel: order.status, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
        await manager.update(TechnicianAssignment, current!.id, { isActive: false, unassignedAt: now, unassignReason: normalized.reason });
        if (booking.visitGroupId) {
          const outcome = await manager.update(VisitGroupItem, { groupId: booking.visitGroupId, bookingId: booking.id, outcome: null },
            { outcome: 'interrupted', outcomeReason: normalized.reason, outcomeAt: now });
          if (outcome.affected !== 1) throw new ConflictException('VisitGroup child outcome changed');
        }
      }
      if (dto.action !== InterruptionAction.REJECT_REQUEST) {
        await manager.insert(OrderStatusHistory, { serviceOrderId: order.id, fromStatus: order.status,
          toStatus: dto.action === InterruptionAction.CLOSE_FOR_REBOOK ? ServiceOrderStatus.CANCELLED : ServiceOrderStatus.ACCEPTED,
          actorUserId: actor.id, actorRole: actor.role, reason: normalized.reason });
      }
      const resolutionCode = dto.action === InterruptionAction.CLOSE_FOR_REBOOK ? 'interrupted_for_rebook'
        : dto.action === InterruptionAction.DIRECT_REASSIGN_SOLO ? 'worker_reassigned' : 'no_action';
      const finalStatus = dto.action === InterruptionAction.REJECT_REQUEST ? SupportCaseStatus.REJECTED : SupportCaseStatus.RESOLVED;
      const nextVersion = supportCase.workflowVersion + 1;
      await manager.update(SupportCase, supportCase.id, { status: finalStatus, resolutionCode,
        resolutionReason: normalized.reason, resolvedAt: now, assignedManagerId: actor.id, holdCompletion: false,
        workflowVersion: nextVersion, interruptionCommandId: dto.commandId, interruptionFingerprint: fingerprint });
      await this.auditLogService.logWithManagerStrict(manager, { actorUserId: actor.id, actorRole: actor.role,
        action: 'MANAGER_RESOLVE_INTERRUPTION', resourceType: 'support_case', resourceId: supportCase.id,
        before: { status: supportCase.status, orderStatus: order.status },
        after: { action: dto.action, resolutionCode, orderId: order.id, visitGroupId: booking.visitGroupId ?? null,
          previousTechnicianId: current?.technicianId ?? null, technicianId: dto.technicianId ?? null } });
      const recipients = [booking.customerId, current?.technicianId, dto.technicianId].filter((id): id is string => !!id);
      await manager.insert(Notification, recipients.map(userId => ({ userId,
        title: dto.action === InterruptionAction.REJECT_REQUEST ? 'Yêu cầu đã được xem xét' : 'Yêu cầu đổi thợ đã được xử lý',
        message: `Quản lý đã xử lý yêu cầu của đơn #${order.code}. Vui lòng xem kết quả.`,
        type: 'MANAGER_RESOLVE_INTERRUPTION', referenceId: supportCase.id, referenceType: 'SUPPORT_CASE' })));
      return { case: this.interruptionCaseResult({ ...supportCase, status: finalStatus, resolutionCode,
        resolutionReason: normalized.reason, workflowVersion: nextVersion, holdCompletion: false }),
        order: { id: order.id, status: dto.action === InterruptionAction.CLOSE_FOR_REBOOK ? ServiceOrderStatus.CANCELLED
          : dto.action === InterruptionAction.DIRECT_REASSIGN_SOLO ? ServiceOrderStatus.ACCEPTED : order.status },
        nextAction: dto.action === InterruptionAction.CLOSE_FOR_REBOOK ? 'interruption_rebook' as const : 'none' as const };
    });
    if (sendGreeting) await this.acceptGreeting?.send(sendGreeting);
    return result;
  }

  private interruptionCaseResult(supportCase: SupportCase) {
    return { id: supportCase.id, status: supportCase.status, workflowVersion: supportCase.workflowVersion,
      requestIntent: supportCase.requestIntent ?? null, resolutionCode: supportCase.resolutionCode ?? null,
      resolutionReason: supportCase.resolutionReason ?? null, serviceOrderId: supportCase.serviceOrderId,
      holdCompletion: supportCase.holdCompletion ?? false };
  }

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
      if (booking.visitGroupId) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'VisitGroup phải được giao cùng một kỹ thuật viên qua luồng lượt sửa.');
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
      await snapshotLaborWarranty(manager, serviceOrder.id, technicianId, booking.serviceId);
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
      if (booking.visitGroupId) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'VisitGroup không cho phép thay thợ một thiết bị.');
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
      await snapshotLaborWarranty(manager, orderId, technicianId, booking.serviceId);

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
      if (booking.visitGroupId) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'VisitGroup không cho phép thay thợ một thiết bị.');
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
      if (await manager.count(AdditionalCostRequest, { where: { serviceOrderId: orderId, status: AdditionalCostStatus.APPROVED } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Chi phí phát sinh đã duyệt cần quản lý đối soát trước khi đổi thợ.');
      }
      if (await manager.count(Invoice, { where: { serviceOrderId: orderId } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn đã có hoá đơn, không đổi thợ được');
      }
      if (order.completionRequestedAt || order.paymentStatus !== PaymentStatus.UNPAID ||
          await manager.count(CashSettlement, { where: { serviceOrderId: orderId } }) ||
          await manager.count(VoucherReservation, { where: { scopeId: orderId } }) ||
          await manager.count(VoucherPaymentLink, { where: { scopeId: orderId } }) ||
          await manager.count(PartRequest, { where: { serviceOrderId: orderId, status: In([
            PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING,
            PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED,
          ]) } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Đơn có thanh toán, ưu đãi hoặc linh kiện cần quản lý đối soát trước khi đổi thợ.');
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
      if (!ServiceOrderStateMachine.canResetAfterManagerInterruption(order.status)) throw new ConflictException('Order cannot be reset');
      await manager.update(ServiceOrder, orderId, { status: ServiceOrderStatus.ACCEPTED, departureWarnedAt: null });
      await manager.save(manager.create(TechnicianAssignment, { serviceOrderId: orderId, technicianId, isActive: true, assignedAt: now }));
      await snapshotLaborWarranty(manager, orderId, technicianId, booking.serviceId);
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
        ...(result.previous ? [{ userId: result.previous, title: 'Đã đổi thợ cho đơn', message: `Quản lý đã giao đơn #${result.code} cho kỹ thuật viên khác theo báo cáo của bạn. Trách nhiệm và điểm uy tín được xem xét riêng theo bằng chứng.` }] : []),
      ];
      await this.notificationsService.createManyNotifications(notes.map((n) => ({ ...n, type: 'TECHNICIAN_REPLACED', referenceId: orderId, referenceType: 'SERVICE_ORDER' }))).catch(() => undefined);
    }
    await this.acceptGreeting?.send({ bookingId: ref.bookingId, technicianId, serviceOrderId: orderId, orderCode: result.code });
    return { orderId, technicianId, previousTechnicianId: result.previous };
  }
}

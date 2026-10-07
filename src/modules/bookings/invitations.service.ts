import { Injectable, ForbiddenException, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ServiceOrderStateMachine } from '../service-orders/service-order-state-machine';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingInvitationGroup } from './entities/booking-invitation-group.entity';
import { Booking } from './entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { InvitationStatus, BookingStatus, ServiceOrderStatus, Role } from '../../shared/enums';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Optional } from '@nestjs/common';
import { activateNextInvitation, invitationActivatedHook } from './activate-next-invitation';
import { eligibilityErrorCode, technicianEligibility } from './technician-eligibility';
import { newOrderCode } from '../service-orders/order-code';
import { startBackgroundJob } from '../../common/background-job';
import { randomUUID } from 'crypto';
import { TechnicianInvitationPreviewDto, toTechnicianInvitationPreview } from './booking-privacy.dto';
import { AcceptGreetingPublisher } from '../messaging/accept-greeting.publisher';

@Injectable()
export class InvitationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitationsService.name);
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(BookingInvitation) private readonly invitationRepo: Repository<BookingInvitation>,
    @InjectRepository(Booking) private readonly bookingRepo: Repository<Booking>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly messagingService: MessagingService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly acceptGreeting?: AcceptGreetingPublisher,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = startBackgroundJob('matching sweep', this.logger, () => this.sweepMatching());
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * #33: an expired invitation used to move on only when someone opened a
   * screen, so a booking whose customer left the matching page stood still.
   * Every minute, each matching booking whose current invitation has expired,
   * or that has a technician on standby and nobody invited, is advanced.
   */
  async sweepMatching(): Promise<void> {
    const rows: Array<{ bookingId: string }> = await this.dataSource.query(
      `SELECT DISTINCT i.booking_id AS "bookingId"
         FROM booking_invitations i
         JOIN bookings b ON b.id = i.booking_id
        WHERE b.status = $1
          AND ((i.status = $2 AND i.expires_at <= now())
            OR (i.status = $3 AND NOT EXISTS (
                  SELECT 1 FROM booking_invitations p WHERE p.booking_id = i.booking_id AND p.status = $2)))`,
      [BookingStatus.MATCHING, InvitationStatus.PENDING, InvitationStatus.STANDBY],
    );
    for (const { bookingId } of rows) {
      try {
        await this.refreshMatching(bookingId);
      } catch (error) {
        this.logger.warn(`matching sweep skipped booking ${bookingId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async createShortlist(bookingId: string, technicianIds: string[], customer: { id: string; role: string }): Promise<BookingInvitation[]> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    if (!Array.isArray(technicianIds) || technicianIds.length < 1 || technicianIds.length > 2 || new Set(technicianIds).size !== technicianIds.length) throw new BusinessException(ErrorCodes.SHORTLIST_LIMIT_EXCEEDED, 'Select 1 or 2 distinct technicians in priority order');
    return this.dataSource.transaction(async manager => {
      const booking = await manager.findOne(Booking, { where: { id: bookingId, customerId: customer.id }, lock: { mode: 'pessimistic_write' } });
      if (!booking) throw new ForbiddenException('Booking not found');
      if (![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.CLOSED].includes(booking.status)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking cannot be shortlisted');
      const existing = await manager.findOneBy(ServiceOrder, { bookingId });
      if (existing && (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(existing.status) || await manager.count(TechnicianAssignment, { where: { serviceOrderId: existing.id, isActive: true } }))) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order already has an active technician');
      const previous = await manager.find(BookingInvitation, { where: { bookingId } });
      if (previous.some(i => [InvitationStatus.PENDING, InvitationStatus.STANDBY].includes(i.status))) throw new BusinessException(ErrorCodes.CONFLICT, 'Current matching round is still active');
      for (const id of technicianIds) {
        const eligibility = await technicianEligibility(manager, id, booking);
        if (!eligibility.eligible) throw new BusinessException(eligibilityErrorCode(eligibility.reason), eligibility.reason!);
      }
      const offset = Math.max(0, ...previous.map(i => i.priorityOrder));
      const group = manager.create(BookingInvitationGroup, { id: randomUUID(), bookingId });
      await manager.save(group);
      const invitations = technicianIds.map((technicianId, i) => manager.create(BookingInvitation, { groupId: group.id, bookingId, technicianId, priorityOrder: offset + i + 1, status: InvitationStatus.STANDBY, invitedAt: new Date(), expiresAt: null }));
      await manager.save(invitations);
      booking.status = BookingStatus.MATCHING;
      await manager.save(booking);
      await this.activateNext(manager, booking);
      await this.auditLogService.logWithManager(manager, { actorUserId: customer.id, actorRole: customer.role, action: 'SHORTLIST_CREATE', resourceType: 'booking', resourceId: bookingId, after: { technicianIds } });
      return manager.find(BookingInvitation, { where: { bookingId }, order: { priorityOrder: 'ASC' } });
    });
  }

  /** Request-time expiration: customer matching poll and technician inbox both advance the queue. */
  async refreshMatching(bookingId: string): Promise<void> {
    await this.dataSource.transaction(async manager => {
      const booking = await manager.findOne(Booking, { where: { id: bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!booking || booking.status !== BookingStatus.MATCHING) return;
      const pending = await manager.find(BookingInvitation, { where: { bookingId, status: InvitationStatus.PENDING } });
      const now = new Date();
      let hasActive = false;
      for (const invitation of pending) {
        if (invitation.expiresAt && invitation.expiresAt > now) {
          hasActive = true;
          continue;
        }
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: now });
      }
      if (hasActive) return;
      await this.activateNext(manager, booking);
    });
  }

  async getMyInvitations(technicianId: string): Promise<TechnicianInvitationPreviewDto[]> {
    const awaiting = await this.invitationRepo.find({ where: [{ technicianId, status: InvitationStatus.PENDING }, { technicianId, status: InvitationStatus.STANDBY }] });
    for (const bookingId of new Set(awaiting.map(i => i.bookingId))) await this.refreshMatching(bookingId);
    const invitations = await this.invitationRepo.find({
      where: { technicianId, status: InvitationStatus.PENDING },
      relations: ['booking'],
      order: { invitedAt: 'DESC' },
    });
    const now = new Date();
    return invitations
      .filter(invitation =>
        invitation.booking &&
        invitation.booking.status === BookingStatus.MATCHING &&
        invitation.status === InvitationStatus.PENDING &&
        invitation.expiresAt != null &&
        invitation.expiresAt > now,
      )
      .map(toTechnicianInvitationPreview);
  }

  async respond(invitationId: string, action: 'ACCEPT' | 'DECLINE', technician: { id: string; role: string }): Promise<{ invitation: BookingInvitation; serviceOrder?: ServiceOrder }> {
    if (technician.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    if (!['ACCEPT', 'DECLINE'].includes(action)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid invitation action');
    const ref = await this.invitationRepo.findOneBy({ id: invitationId, technicianId: technician.id });
    if (!ref) throw new ForbiddenException('Invitation not found');
    let accepted: { bookingId: string; serviceOrderId: string; orderCode: string } | null = null;
    const outcome = await this.dataSource.transaction(async manager => {
      // All matching commands lock Booking first; User lock serializes Accept across bookings.
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!booking) throw new ForbiddenException('Booking not found');
      const invitation = await manager.findOneByOrFail(BookingInvitation, { id: invitationId, technicianId: technician.id });
      if (invitation.status === InvitationStatus.ACCEPTED && action === 'ACCEPT') {
        // An ACCEPTED invitation is historical; only the still-assigned winner
        // may replay Accept and receive the order (which carries location data).
        const existingOrder = await manager.findOneBy(ServiceOrder, { bookingId: booking.id });
        if (!existingOrder || booking.status !== BookingStatus.MATCHED ||
            existingOrder.status === ServiceOrderStatus.CANCELLED ||
            !await manager.findOneBy(TechnicianAssignment, {
              serviceOrderId: existingOrder.id, technicianId: technician.id, isActive: true,
            })) {
          throw new BusinessException(ErrorCodes.INVITATION_ALREADY_TAKEN, 'Invitation is no longer assigned to this technician');
        }
        return { invitation, serviceOrder: existingOrder };
      }
      if (invitation.status === InvitationStatus.DECLINED && action === 'DECLINE') return { invitation };
      if (booking.status !== BookingStatus.MATCHING || invitation.status !== InvitationStatus.PENDING) throw new BusinessException(ErrorCodes.INVITATION_ALREADY_TAKEN, 'Invitation is no longer active');
      if (!invitation.expiresAt || invitation.expiresAt <= new Date()) {
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: new Date() });
        await this.activateNext(manager, booking);
        return { expired: true as const };
      }
      if (action === 'DECLINE') {
        invitation.status = InvitationStatus.DECLINED;
        invitation.respondedAt = new Date();
        await manager.save(invitation);
        await this.activateNext(manager, booking);
        return { invitation };
      }
      await manager.findOne(User, { where: { id: technician.id }, lock: { mode: 'pessimistic_write' } });
      if (invitation.expiresAt <= new Date()) {
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: new Date() });
        await this.activateNext(manager, booking);
        return { expired: true as const };
      }
      // Existing, still-valid PENDING invitation may be accepted after pause; all other guards still apply.
      const eligibility = await technicianEligibility(manager, technician.id, booking, undefined, { allowPausedExistingInvitation: true });
      if (!eligibility.eligible) throw new BusinessException(eligibilityErrorCode(eligibility.reason), eligibility.reason!);
      let serviceOrder = await manager.findOneBy(ServiceOrder, { bookingId: booking.id });
      const now = new Date();
      const code = serviceOrder?.code ?? newOrderCode(now);
      const replacement = !!serviceOrder;
      if (serviceOrder && (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(serviceOrder.status) || await manager.count(TechnicianAssignment, { where: { serviceOrderId: serviceOrder.id, isActive: true } }))) throw new BusinessException(ErrorCodes.INVITATION_ALREADY_TAKEN, 'Booking already assigned');
      if (serviceOrder && serviceOrder.status === ServiceOrderStatus.EN_ROUTE && ServiceOrderStateMachine.canResetForReplacement(serviceOrder.status)) {
        // #34: the previous technician withdrew on the way; the replacement has
        // not set out, so the order goes back to ACCEPTED instead of inheriting EN_ROUTE.
        await manager.update(ServiceOrder, serviceOrder.id, { status: ServiceOrderStatus.ACCEPTED });
        await manager.insert(OrderStatusHistory, { serviceOrderId: serviceOrder.id, fromStatus: ServiceOrderStatus.EN_ROUTE, toStatus: ServiceOrderStatus.ACCEPTED, actorUserId: technician.id, actorRole: technician.role, reason: 'Replacement technician has not set out yet' });
        serviceOrder.status = ServiceOrderStatus.ACCEPTED;
      }
      if (serviceOrder) {
        // A new technician gets their own departure clock (BRX-063).
        await manager.update(ServiceOrder, serviceOrder.id, { departureWarnedAt: null, scheduledAt: booking.preferredStartAt });
      }
      serviceOrder ??= await manager.save(ServiceOrder, manager.create(ServiceOrder, { bookingId: booking.id, code, status: ServiceOrderStatus.ACCEPTED, scheduledAt: booking.preferredStartAt }));
      await manager.save(TechnicianAssignment, manager.create(TechnicianAssignment, { serviceOrderId: serviceOrder.id, technicianId: technician.id, isActive: true, assignedAt: now }));
      await manager.insert(OrderStatusHistory, { serviceOrderId: serviceOrder.id, fromStatus: replacement ? serviceOrder.status : null, toStatus: serviceOrder.status, actorUserId: technician.id, actorRole: technician.role, reason: replacement ? 'Replacement technician accepted invitation' : 'Technician accepted invitation' });
      invitation.status = InvitationStatus.ACCEPTED;
      invitation.respondedAt = now;
      await manager.save(invitation);
      await manager.createQueryBuilder().update(BookingInvitation).set({ status: InvitationStatus.CANCELLED, respondedAt: now }).where('booking_id = :bookingId AND id != :id AND status IN (:...statuses)', { bookingId: booking.id, id: invitation.id, statuses: [InvitationStatus.PENDING, InvitationStatus.STANDBY] }).execute();
      await manager.update(Booking, booking.id, { status: BookingStatus.MATCHED });
      // Spec 8.6: the accepted thread follows the ServiceOrder; the threads with
      // the technicians who were passed over become read-only, never deleted.
      await this.messagingService.ensureConversation(manager, booking, technician.id);
      await this.messagingService.attachToServiceOrder(manager, booking.id, technician.id, serviceOrder.id);
      await manager.update(TechnicianProfile, { userId: technician.id }, { priorityBoostUntil: null });
      await this.auditLogService.logWithManager(manager, { actorUserId: technician.id, actorRole: technician.role, action: 'INVITATION_ACCEPT', resourceType: 'booking_invitation', resourceId: invitation.id, after: { serviceOrderId: serviceOrder.id, code } });
      if (this.notificationsService && booking.customerId) {
        void this.notificationsService.createNotification({
          userId: booking.customerId,
          title: 'Đã có Kỹ thuật viên nhận đơn!',
          message: `Kỹ thuật viên đã đồng ý tiếp nhận đơn hàng #${code}. Kỹ thuật viên sẽ di chuyển và liên hệ với bạn theo đúng lịch hẹn.`,
          type: 'TECHNICIAN_ASSIGNED',
          referenceId: serviceOrder.id,
          referenceType: 'SERVICE_ORDER',
        });
      }
      accepted = { bookingId: booking.id, serviceOrderId: serviceOrder.id, orderCode: code };
      return { invitation, serviceOrder };
    });
    if ('expired' in outcome) throw new BusinessException(ErrorCodes.INVITATION_EXPIRED, 'Invitation expired');
    // After commit: the customer hears from the technician who took the job.
    if (accepted) await this.acceptGreeting?.send({ ...(accepted as { bookingId: string; serviceOrderId: string; orderCode: string }), technicianId: technician.id });
    return outcome;
  }

  async checkTechnicianEligibility(technicianId: string, booking: Booking, manager?: EntityManager) {
    return technicianEligibility(manager ?? this.dataSource.manager, technicianId, booking);
  }

  async inviteNextCandidate(bookingId: string): Promise<BookingInvitation | null> {
    await this.refreshMatching(bookingId);
    return this.invitationRepo.findOneBy({ bookingId, status: InvitationStatus.PENDING });
  }

  /**
   * One customer-confirmed extension for the currently live invitation round.
   * Booking is always locked first, matching Accept/cancel/refreshMatching.
   */
  async extendPendingInvitationGroup(
    bookingId: string,
    customer: { id: string; role: string },
  ): Promise<{
    bookingId: string;
    invitationGroupId: string;
    expiresAt: Date;
    extendedInvitationCount: number;
  }> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    return this.dataSource.transaction(async manager => {
      const booking = await manager.findOne(Booking, {
        where: { id: bookingId, customerId: customer.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new ForbiddenException('Booking not found');
      if (booking.status !== BookingStatus.MATCHING) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Booking has no live matching round');
      }
      const now = new Date();
      const preferredEndAt = booking.preferredEndAt;
      if (!(preferredEndAt instanceof Date) || !Number.isFinite(preferredEndAt.getTime()) || preferredEndAt <= now) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'A valid future preferred arrival window is required');
      }

      const pending = await manager.find(BookingInvitation, {
        where: { bookingId, status: InvitationStatus.PENDING },
      });
      const groupIds = [...new Set(pending.map(invitation => invitation.groupId).filter((id): id is string => !!id))];
      if (pending.length === 0 || groupIds.length !== 1 || pending.some(invitation => !invitation.groupId)) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'No durable live invitation group');
      }
      const invitationGroupId = groupIds[0];
      const group = await manager.findOne(BookingInvitationGroup, {
        where: { id: invitationGroupId, bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!group) throw new BusinessException(ErrorCodes.CONFLICT, 'Invitation group is unavailable');
      if (group.extensionUsedAt) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Invitation group extension already used');
      }

      if (pending.some(invitation => !invitation.expiresAt || invitation.expiresAt <= now)) {
        throw new BusinessException(ErrorCodes.INVITATION_EXPIRED, 'Invitation group is no longer live');
      }
      const latestCurrentExpiry = Math.max(...pending.map(invitation => invitation.expiresAt!.getTime()));
      const ttlMinutes = await this.configService.getInt('matching.invitation_ttl_minutes', 30);
      const configuredExpiry = new Date(now.getTime() + Math.max(0, ttlMinutes) * 60_000);
      const expiresAt = preferredEndAt < configuredExpiry
        ? preferredEndAt
        : configuredExpiry;
      if (expiresAt.getTime() <= latestCurrentExpiry) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Preferred arrival window cannot extend this matching round');
      }

      await manager.createQueryBuilder()
        .update(BookingInvitation)
        .set({ expiresAt })
        .where('booking_id = :bookingId AND group_id = :groupId AND status = :status', {
          bookingId,
          groupId: invitationGroupId,
          status: InvitationStatus.PENDING,
        })
        .execute();
      await manager.update(BookingInvitationGroup, invitationGroupId, { extensionUsedAt: now });
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: customer.role,
        action: 'MATCHING_INVITATION_GROUP_EXTEND',
        resourceType: 'booking_invitation_group',
        resourceId: invitationGroupId,
        after: { bookingId, expiresAt: expiresAt.toISOString(), extendedInvitationCount: pending.length },
      });
      return { bookingId, invitationGroupId, expiresAt, extendedInvitationCount: pending.length };
    });
  }

  private async activateNext(manager: EntityManager, booking: Booking): Promise<void> {
    const wasMatching = booking.status === BookingStatus.MATCHING;
    await activateNextInvitation(
      manager,
      booking,
      await this.configService.getInt('matching.invitation_ttl_minutes', 30),
      // Spec 8.6 / CHAT-BR-01: chat opens with the invitation, not with Accept.
      invitationActivatedHook(this.notificationsService, (m, b, t) => this.messagingService.ensureConversation(m, b, t).then(() => undefined)),
    );
    // Nobody left to invite: tell the customer instead of leaving the booking silent.
    const after = await manager.findOneBy(Booking, { id: booking.id });
    if (wasMatching && after?.status === BookingStatus.CLOSED && this.notificationsService && booking.customerId) {
      void this.notificationsService.createNotification({
        userId: booking.customerId,
        title: 'Chưa có kỹ thuật viên nhận lời mời',
        message: 'Các kỹ thuật viên bạn chọn đều chưa nhận lời mời. Bạn có thể chọn kỹ thuật viên khác để tiếp tục.',
        type: 'BOOKING_MATCHING_EXHAUSTED',
        referenceId: booking.id,
        referenceType: 'BOOKING',
      }).catch(() => undefined);
    }
  }
}

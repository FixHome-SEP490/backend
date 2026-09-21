import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingInvitation } from './entities/booking-invitation.entity';
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
import { activateNextInvitation } from './activate-next-invitation';
import { technicianEligibility } from './technician-eligibility';
import { TechnicianInvitationPreviewDto, toTechnicianInvitationPreview } from './booking-privacy.dto';

@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(BookingInvitation) private readonly invitationRepo: Repository<BookingInvitation>,
    @InjectRepository(Booking) private readonly bookingRepo: Repository<Booking>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly messagingService: MessagingService,
  ) {}

  async createShortlist(bookingId: string, technicianIds: string[], customer: { id: string; role: string }): Promise<BookingInvitation[]> {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    if (!Array.isArray(technicianIds) || technicianIds.length < 1 || technicianIds.length > 5 || new Set(technicianIds).size !== technicianIds.length) throw new BusinessException(ErrorCodes.SHORTLIST_LIMIT_EXCEEDED, 'Select 1 to 5 distinct technicians');
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
        if (!eligibility.eligible) throw new BusinessException(ErrorCodes.WORK_SUSPENDED, eligibility.reason!);
      }
      const offset = Math.max(0, ...previous.map(i => i.priorityOrder));
      const invitations = technicianIds.map((technicianId, i) => manager.create(BookingInvitation, { bookingId, technicianId, priorityOrder: offset + i + 1, status: InvitationStatus.STANDBY, invitedAt: new Date(), expiresAt: null }));
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
    const outcome = await this.dataSource.transaction(async manager => {
      // All matching commands lock Booking first; User lock serializes Accept across bookings.
      const booking = await manager.findOne(Booking, { where: { id: ref.bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!booking) throw new ForbiddenException('Booking not found');
      const invitation = await manager.findOneByOrFail(BookingInvitation, { id: invitationId, technicianId: technician.id });
      if (invitation.status === InvitationStatus.ACCEPTED && action === 'ACCEPT') {
        return { invitation, serviceOrder: await manager.findOneByOrFail(ServiceOrder, { bookingId: booking.id }) };
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
      if (!eligibility.eligible) throw new BusinessException(ErrorCodes.WORK_SUSPENDED, eligibility.reason!);
      let serviceOrder = await manager.findOneBy(ServiceOrder, { bookingId: booking.id });
      const now = new Date();
      const code = serviceOrder?.code ?? 'FH-' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomUUID().slice(0, 8).toUpperCase();
      const replacement = !!serviceOrder;
      if (serviceOrder && (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(serviceOrder.status) || await manager.count(TechnicianAssignment, { where: { serviceOrderId: serviceOrder.id, isActive: true } }))) throw new BusinessException(ErrorCodes.INVITATION_ALREADY_TAKEN, 'Booking already assigned');
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
      return { invitation, serviceOrder };
    });
    if ('expired' in outcome) throw new BusinessException(ErrorCodes.INVITATION_EXPIRED, 'Invitation expired');
    return outcome;
  }

  async checkTechnicianEligibility(technicianId: string, booking: Booking, manager?: EntityManager) {
    return technicianEligibility(manager ?? this.dataSource.manager, technicianId, booking);
  }

  async inviteNextCandidate(bookingId: string): Promise<BookingInvitation | null> {
    await this.refreshMatching(bookingId);
    return this.invitationRepo.findOneBy({ bookingId, status: InvitationStatus.PENDING });
  }

  private async activateNext(manager: EntityManager, booking: Booking): Promise<void> {
    await activateNextInvitation(
      manager,
      booking,
      await this.configService.getInt('matching.invitation_ttl_minutes', 30),
      // Spec 8.6 / CHAT-BR-01: chat opens with the invitation, not with Accept.
      async (txManager, txBooking, technicianId) => {
        await this.messagingService.ensureConversation(txManager, txBooking, technicianId);
      },
    );
  }
}

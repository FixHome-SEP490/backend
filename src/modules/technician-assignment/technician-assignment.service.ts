// src/modules/technician-assignment/technician-assignment.service.ts
import { Injectable, Logger, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ServiceOrderStatus, BookingStatus, InvitationStatus, Role } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { technicianEligibility } from '../bookings/technician-eligibility';
import { releaseOutgoingTechnicianPartRequests } from '../part-requests/part-request-lifecycle';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MessagingService } from '../messaging/messaging.service';
import { AcceptGreetingPublisher } from '../messaging/accept-greeting.publisher';

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
      const code = existingOrder?.code ?? 'FH-' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomUUID().slice(0, 8).toUpperCase();
      const serviceOrder = existingOrder ?? await manager.save(ServiceOrder, manager.create(ServiceOrder, { bookingId: booking.id, code, status: ServiceOrderStatus.ACCEPTED, scheduledAt: booking.preferredStartAt }));
      const assignment = await manager.save(TechnicianAssignment, manager.create(TechnicianAssignment, { serviceOrderId: serviceOrder.id, technicianId, isActive: true, assignedAt: now }));
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
}

// src/modules/technician-assignment/technician-assignment.service.ts
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
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
import { AuditLogService } from '../audit-log/audit-log.service';
import { MessagingService } from '../messaging/messaging.service';

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
    return this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, { where: { id: bookingId }, lock: { mode: 'pessimistic_write' } });
      if (!booking) throw new NotFoundException('Booking not found');
      if (![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.CLOSED].includes(booking.status)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking is not open for manual assignment');
      const existingOrder = await manager.findOneBy(ServiceOrder, { bookingId });
      if (existingOrder && (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(existingOrder.status) || await manager.count(TechnicianAssignment, { where: { serviceOrderId: existingOrder.id, isActive: true } }))) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Booking already has an active technician');
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
  }

  /**
   * Override / manual assignment of technician to a service order by SM or Admin.
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
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(ServiceOrder, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new NotFoundException('Service order not found');
      // Mid-job replacement needs the DEV2 financial/manual resolution workflow.
      if (order.status !== ServiceOrderStatus.ACCEPTED) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Only pre-departure reassignment is supported; later replacement requires manual resolution');
      await manager.findOne(User, { where: { id: technicianId }, lock: { mode: 'pessimistic_write' } });
      const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
      const eligibility = await technicianEligibility(manager, technicianId, booking, orderId);
      if (!eligibility.eligible) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, eligibility.reason!);
      // 1. Deactivate existing active assignment if any
      const existingAssignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: orderId, isActive: true },
      });

      if (existingAssignment) {
        existingAssignment.isActive = false;
        existingAssignment.unassignedAt = new Date();
        existingAssignment.unassignReason =
          reason || 'Overridden by Staff/Admin';
        await manager.save(existingAssignment);
      }

      // 2. Create new active assignment
      const newAssignment = manager.create(TechnicianAssignment, {
        serviceOrderId: orderId,
        technicianId,
        isActive: true,
        assignedAt: new Date(),
      });
      const savedAssignment = await manager.save(newAssignment);

      // 3. Record status history for reassignment
      const history = manager.create(OrderStatusHistory, {
        serviceOrderId: orderId,
        fromStatus: order.status,
        toStatus: order.status,
        actorUserId: actorUser.id,
        actorRole: actorUser.role,
        reason: reason || 'Technician manually assigned/reassigned by Staff/Admin',
      });
      await manager.save(history);

      // 4. Audit Log
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

      this.logger.log(
        `Technician ${technicianId} assigned to order ${orderId} by ${actorUser.id}`,
      );

      return savedAssignment;
    });
  }
}

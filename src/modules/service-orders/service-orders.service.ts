import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, LessThanOrEqual } from 'typeorm';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { Cancellation } from './entities/cancellation.entity';
import { CancellationStrike } from './entities/cancellation-strike.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostItem } from './entities/additional-cost-item.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { CustomerServiceConfirmation } from './entities/customer-service-confirmation.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { BookingInvitationGroup } from '../bookings/entities/booking-invitation-group.entity';
import { activateNextInvitation } from '../bookings/activate-next-invitation';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { ServiceOrderStateMachine } from './service-order-state-machine';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { haversineKm } from '../../shared/utils/geo';
import { normalizePhone } from '../../shared/validation/input.transforms';
import {
  ServiceOrderStatus,
  BookingStatus,
  InvitationStatus,
  CheckInResult,
  EvidenceType,
  CancelActor,
  CompensationStatus,
  StrikeStatus,
  PaymentStatus,
  QuotationStatus,
  AdditionalCostStatus,
  Role,
  CostItemType,
  WarrantyStatus,
  ServicePricingMode,
  WarrantyClaimStatus,
  PartSource,
  PartWarrantyOption,
} from '../../shared/enums';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { FinanceService, FinanceActor } from '../finance/finance.service';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  CommissionDueResponseDto,
  InitiatePaymentDto,
  InvoiceResponseDto,
  PaymentResponseDto,
  CashSettlementResponseDto,
} from '../finance/dto';
import type { EntityManager } from 'typeorm';
import { OrderEvidenceStorage, EvidenceFile } from '../media/order-evidence-storage.service';
import { expireAdditionalCosts } from './expire-additional-costs';
import { authorizeOrder } from './order-access';
import { historicalOrderSummary, type HistoricalOrderSummary } from './historical-order-summary';

@Injectable()
export class ServiceOrdersService {
  private readonly logger = new Logger(ServiceOrdersService.name);

  constructor(
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(OrderStatusHistory)
    private readonly historyRepo: Repository<OrderStatusHistory>,
    @InjectRepository(ArrivalCheckIn)
    private readonly checkInRepo: Repository<ArrivalCheckIn>,
    @InjectRepository(RepairEvidence)
    private readonly evidenceRepo: Repository<RepairEvidence>,
    @InjectRepository(Cancellation)
    private readonly cancellationRepo: Repository<Cancellation>,
    @InjectRepository(CancellationStrike)
    private readonly strikeRepo: Repository<CancellationStrike>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(InvoiceItem)
    private readonly invoiceItemRepo: Repository<InvoiceItem>,
    @InjectRepository(WarrantyCoverage)
    private readonly warrantyRepo: Repository<WarrantyCoverage>,
    @InjectRepository(AdditionalCostRequest)
    private readonly additionalCostRepo: Repository<AdditionalCostRequest>,
    @InjectRepository(WarrantyClaim)
    private readonly warrantyClaimRepo: Repository<WarrantyClaim>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TechnicianProfile)
    private readonly techProfileRepo: Repository<TechnicianProfile>,
    @InjectRepository(CustomerServiceConfirmation)
    private readonly confirmationRepo: Repository<CustomerServiceConfirmation>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly evidenceStorage: OrderEvidenceStorage,
    private readonly financeService: FinanceService,
  ) {}

  // ── Queries ──

  /** Lazy expiry (same pattern as expireAdditionalCosts): technician never started past the scheduled time + grace. */
  private async cancelOverdueOrders(): Promise<void> {
    const graceMinutes = await this.configService.getInt('order.overdue_grace_minutes', 60);
    const overdue = await this.orderRepo.find({ where: { status: ServiceOrderStatus.ACCEPTED, scheduledAt: LessThanOrEqual(new Date(Date.now() - graceMinutes * 60000)) } });
    for (const order of overdue) {
      await this.dataSource.transaction(async manager => {
        const fresh = await manager.findOne(ServiceOrder, { where: { id: order.id }, lock: { mode: 'pessimistic_write' } });
        if (!fresh || fresh.status !== ServiceOrderStatus.ACCEPTED) return;
        await manager.update(ServiceOrder, fresh.id, { status: ServiceOrderStatus.CANCELLED, cancelledAt: new Date() });
        await manager.update(TechnicianAssignment, { serviceOrderId: fresh.id, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: 'Overdue: technician did not start on schedule' });
        await manager.insert(OrderStatusHistory, { serviceOrderId: fresh.id, fromStatus: ServiceOrderStatus.ACCEPTED, toStatus: ServiceOrderStatus.CANCELLED, reason: 'Auto-cancelled: overdue past scheduled time' });
      });
    }
  }

  async findAll(options: {
    page?: number;
    limit?: number;
    status?: ServiceOrderStatus;
    search?: string;
  }): Promise<{ data: ServiceOrder[]; total: number }> {
    await this.cancelOverdueOrders();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo.createQueryBuilder('o');

    if (options.status) {
      qb.andWhere('o.status = :status', { status: options.status });
    }
    if (options.search) {
      qb.andWhere('o.code ILIKE :search', { search: `%${options.search}%` });
    }

    qb.orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data: await Promise.all(data.map(order => this.presentOrder(order))), total };
  }

  async findMyOrders(
    userId: string,
    role: string,
    options: { page?: number; limit?: number; status?: ServiceOrderStatus },
  ): Promise<{ data: (ServiceOrder | HistoricalOrderSummary)[]; total: number }> {
    await this.cancelOverdueOrders();
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo.createQueryBuilder('o');

    if (role === Role.CUSTOMER) {
      qb.innerJoin('bookings', 'b', 'b.id = o.booking_id')
        .where('b.customer_id = :userId', { userId });
    } else if (role === Role.TECHNICIAN) {
      qb.innerJoin(
        'technician_assignments',
        'ta',
        'ta.service_order_id = o.id',
      ).where('ta.technician_id = :userId', { userId });
    } else {
      throw new ForbiddenException('Order list access denied');
    }

    if (options.status) {
      qb.andWhere('o.status = :status', { status: options.status });
    }

    qb.orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data: await Promise.all(data.map(async order => {
        if (role !== Role.TECHNICIAN) return this.presentOrder(order);
        const assignment = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
          serviceOrderId: order.id, technicianId: userId, isActive: true,
        });
        return assignment ? this.presentOrder(order) : historicalOrderSummary(order);
      })),
      total,
    };
  }

  async findById(
    id: string,
    actor: { id: string; role: string },
  ): Promise<ServiceOrder | HistoricalOrderSummary> {
    await this.cancelOverdueOrders();
    const order = await this.orderRepo.findOneBy({ id });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    if (actor.role === Role.TECHNICIAN) {
      const active = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
        serviceOrderId: id, technicianId: actor.id, isActive: true,
      });
      if (active) return this.presentOrder(order);
      const historical = await this.dataSource.manager.findOneBy(TechnicianAssignment, {
        serviceOrderId: id, technicianId: actor.id,
      });
      if (historical) return historicalOrderSummary(order);
      throw new ForbiddenException('Order not found or access denied');
    }
    await this.checkOrderAccess(order, actor);
    return this.presentOrder(order);
  }

  /**
   * Public guest lookup by order code + registered phone (no auth).
   * Same generic not-found error whether the code or the phone is wrong,
   * to avoid letting a caller enumerate order codes.
   */
  async trackPublic(orderCode: string, phone: string) {
    const order = await this.orderRepo.findOneBy({ code: orderCode });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    const booking = await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
    const customer = booking ? await this.dataSource.manager.findOneBy(User, { id: booking.customerId }) : null;
    if (!customer || customer.phoneNumber !== normalizePhone(phone)) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    const presented = await this.presentOrder(order);
    const trackableStatus = presented.status === ServiceOrderStatus.EN_ROUTE || presented.status === ServiceOrderStatus.UNDER_REPAIR;
    return {
      code: presented.code,
      status: presented.status,
      serviceName: (presented as unknown as { serviceName?: string }).serviceName,
      technician: (presented as unknown as { technician?: { fullName: string; phoneNumber: string } }).technician,
      destination: (presented as unknown as { destination?: { lat: number; lng: number } | null }).destination,
      technicianLocation: trackableStatus ? (presented as unknown as { technicianLocation?: unknown }).technicianLocation : null,
      timeline: ((presented as unknown as { timeline: { status: string; timestamp: string }[] }).timeline)
        .map((t) => ({ status: t.status, timestamp: t.timestamp })),
    };
  }

  // ── State Transitions (D-22: all within transaction) ──

  /**
   * Transition to EN_ROUTE.
   */
  private async presentOrder(order: ServiceOrder): Promise<ServiceOrder> {
    const manager = this.dataSource.manager;
    const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
    const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } });
    const technician = assignment ? await manager.findOneBy(User, { id: assignment.technicianId }) : null;
    const customer = await manager.findOneBy(User, { id: booking.customerId });
    const quotation = await manager.findOne(Quotation, { where: { serviceOrderId: order.id }, relations: ['items'], order: { version: 'DESC' } });
    const history = await this.historyRepo.find({ where: { serviceOrderId: order.id }, order: { createdAt: 'ASC' } });
    return Object.assign(order, {
      serviceName: booking.serviceNameSnapshot || '', addressSummary: booking.addressTextSnapshot || '',
      pricingMode: booking.pricingModeSnapshot,
      fixedUnitPrice: booking.fixedUnitPriceSnapshot ? Number(booking.fixedUnitPriceSnapshot) : null,
      quantity: booking.quantity || 1,
      scopeDescription: booking.scopeSnapshot || '',
      bookingDescription: booking.description || '',
      customerName: customer?.fullName || '', customerPhone: customer?.phoneNumber || '',
      technician: technician ? { id: technician.id, fullName: technician.fullName, phoneNumber: technician.phoneNumber } : undefined,
      destination: booking.latitudeSnapshot != null && booking.longitudeSnapshot != null
        ? { lat: Number(booking.latitudeSnapshot), lng: Number(booking.longitudeSnapshot) }
        : null,
      technicianLocation: order.technicianLastLat != null && order.technicianLastLng != null
        ? { lat: Number(order.technicianLastLat), lng: Number(order.technicianLastLng), updatedAt: order.technicianLocationUpdatedAt?.toISOString() ?? null }
        : null,
      quotation, customerConfirmed: !!await manager.findOneBy(CustomerServiceConfirmation, { serviceOrderId: order.id }),
      arrivalVerified: !!await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: order.id, technicianId: assignment?.technicianId, result: CheckInResult.VALID }),
      beforeEvidenceCount: await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.BEFORE } }),
      afterEvidenceCount: await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.AFTER } }),
      timeline: history.map(h => ({ status: h.toStatus, title: h.reason, timestamp: h.createdAt.toISOString(), actor: h.actorRole })),
    });
  }

  async enRoute(
    orderId: string,
    actor: { id: string; role: string },
  ): Promise<ServiceOrder> {
    return this.transitionStatus(
      orderId,
      ServiceOrderStatus.EN_ROUTE,
      actor,
      'Technician en route',
    );
  }

  /**
   * GPS check-in. Creates ArrivalCheckIn record.
   */
  async checkIn(orderId: string, body: { lat: number; lng: number; accuracyMeters: number; deviceInfo?: Record<string, unknown> }, actor: { id: string; role: string }): Promise<ArrivalCheckIn> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be EN_ROUTE');
      const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
      if (![body.lat, body.lng, body.accuracyMeters].every(Number.isFinite) || Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180 || body.accuracyMeters < 0) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid GPS coordinates');
      if (booking.latitudeSnapshot == null || booking.longitudeSnapshot == null) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Repair address has no verified coordinates');
      const lat = Number(booking.latitudeSnapshot), lng = Number(booking.longitudeSnapshot);
      const distanceMeters = Math.round(haversineKm(lat, lng, body.lat, body.lng) * 1000);
      const radius = await this.configService.getInt('geofence.radius_meters', 300);
      const accuracy = await this.configService.getInt('geofence.min_gps_accuracy_meters', 100);
      const result = body.accuracyMeters > accuracy ? CheckInResult.LOW_ACCURACY : distanceMeters > radius ? CheckInResult.OUT_OF_GEOFENCE : CheckInResult.VALID;
      return manager.save(ArrivalCheckIn, manager.create(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, lat: body.lat, lng: body.lng, accuracyMeters: body.accuracyMeters, distanceMeters, result, checkedInAt: new Date(), deviceInfo: body.deviceInfo || null }));
    });
  }

  /**
   * Live GPS ping while EN_ROUTE, for the customer tracking map. Not a geofence check.
   */
  async updateLocation(orderId: string, body: { lat: number; lng: number; accuracyMeters?: number }, actor: { id: string; role: string }): Promise<{ lat: number; lng: number; updatedAt: string }> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be EN_ROUTE');
      if (![body.lat, body.lng].every(Number.isFinite) || Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid GPS coordinates');
      const updatedAt = new Date();
      await manager.update(ServiceOrder, orderId, { technicianLastLat: body.lat, technicianLastLng: body.lng, technicianLocationUpdatedAt: updatedAt });
      return { lat: body.lat, lng: body.lng, updatedAt: updatedAt.toISOString() };
    });
  }


  async startRepair(orderId: string, actor: { id: string; role: string }): Promise<ServiceOrder> {
    return this.transitionStatus(orderId, ServiceOrderStatus.UNDER_REPAIR, actor, 'Repair started');
  }


  async requestCompletion(orderId: string, body: { completionNote?: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order must be UNDER_REPAIR');
      await this.assertCompletionReady(manager, order);
      if (order.completionRequestedAt) return order;
      await this.generateInvoice(orderId, manager);
      await manager.update(ServiceOrder, orderId, { completionRequestedAt: new Date(), completionNote: body.completionNote?.trim() || null });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ORDER_COMPLETION_REQUESTED', resourceType: 'service_order', resourceId: orderId });
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }


  async confirmCompletion(orderId: string, body: { feedback?: string; rating?: number; signatureUrl?: string }, actor: { id: string; role: string }): Promise<{ confirmation: CustomerServiceConfirmation; order: ServiceOrder }> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'customer', true);
      let confirmation = await manager.findOneBy(CustomerServiceConfirmation, { serviceOrderId: orderId });
      if (order.status === ServiceOrderStatus.COMPLETED && confirmation) return { order, confirmation };
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Technician completion request required');
      await this.assertCompletionReady(manager, order);
      if (!confirmation) {
        confirmation = await manager.save(CustomerServiceConfirmation, manager.create(CustomerServiceConfirmation, { serviceOrderId: orderId, customerId: actor.id, confirmedAt: new Date(), feedback: body.feedback || null, rating: body.rating ?? null, signatureUrl: body.signatureUrl || null }));
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'CUSTOMER_COMPLETION_CONFIRMED', resourceType: 'service_order', resourceId: orderId });
      }
      await this.finalizeIfSatisfied(manager, order, actor);
      return { confirmation, order: await manager.findOneByOrFail(ServiceOrder, { id: orderId }) };
    });
  }


  /** Legacy route remains available, but cannot bypass the completion/payment gate. */
  async complete(orderId: string, _body: { completionNote?: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status === ServiceOrderStatus.COMPLETED) return order;
      if (!await this.finalizeIfSatisfied(manager, order, actor)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Customer confirmation and verified payment are required');
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }


  async cancel(orderId: string, body: { reason: string }, actor: { id: string; role: string }): Promise<ServiceOrder> {
    if (!body.reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Cancellation reason required');
    const reference = await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.dataSource.transaction(async manager => {
      const booking = await manager.findOneOrFail(Booking, { where: { id: reference.bookingId }, lock: { mode: 'pessimistic_write' } });
      const order = await authorizeOrder(manager, orderId, actor, actor.role === Role.TECHNICIAN ? 'technician' : 'read', true);
      if (order.status === ServiceOrderStatus.CANCELLED) return order;
      const arrived = await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, result: CheckInResult.VALID });
      if (actor.role === Role.TECHNICIAN && arrived) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'After arrival, request Service Manager exception handling');
      if (actor.role === Role.CUSTOMER && order.status === ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'During repair, request Service Manager exception handling');
      const from = order.status;
      if (actor.role === Role.TECHNICIAN && !arrived && [ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(from)) {
        await manager.update(TechnicianAssignment, { serviceOrderId: orderId, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: body.reason });
        await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: orderId, actor: CancelActor.TECHNICIAN, actorUserId: actor.id, reason: body.reason, stateAtCancel: from, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
        const previous = await manager.find(BookingInvitation, { where: { bookingId: booking.id }, order: { priorityOrder: 'ASC' } });
        const last = Math.max(0, ...previous.filter(inv => inv.status === InvitationStatus.ACCEPTED).map(inv => inv.priorityOrder));
        // Append a fresh invitation round; the original dispatch history stays immutable.
        const remaining = previous.filter(inv => inv.priorityOrder > last && inv.status === InvitationStatus.CANCELLED);
        const offset = Math.max(0, ...previous.map(inv => inv.priorityOrder));
        const group = remaining.length > 0
          ? manager.create(BookingInvitationGroup, { id: randomUUID(), bookingId: booking.id })
          : null;
        if (group) await manager.save(group);
        for (const [index, candidate] of remaining.entries()) await manager.save(BookingInvitation, manager.create(BookingInvitation, { groupId: group!.id, bookingId: booking.id, technicianId: candidate.technicianId, priorityOrder: offset + index + 1, status: InvitationStatus.STANDBY, invitedAt: new Date(), expiresAt: null }));
        booking.status = BookingStatus.MATCHING;
        await manager.save(booking);
        await activateNextInvitation(manager, booking, await this.configService.getInt('matching.invitation_ttl_minutes', 30));
        await manager.insert(OrderStatusHistory, { serviceOrderId: orderId, fromStatus: from, toStatus: from, actorUserId: actor.id, actorRole: actor.role, reason: 'Technician withdrew before arrival; awaiting replacement: ' + body.reason });
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'TECHNICIAN_WITHDRAWAL_REMATCH', resourceType: 'service_order', resourceId: orderId, after: { reason: body.reason, strikeApplied: false } });
        return order;
      }
      await this.commitTransition(manager, order, ServiceOrderStatus.CANCELLED, actor, body.reason);
      await manager.update(Booking, booking.id, { status: BookingStatus.CANCELLED });
      await manager.createQueryBuilder().update(BookingInvitation).set({ status: InvitationStatus.CANCELLED, respondedAt: new Date() }).where('booking_id = :id AND status IN (:...states)', { id: booking.id, states: [InvitationStatus.PENDING, InvitationStatus.STANDBY] }).execute();
      await manager.save(Cancellation, manager.create(Cancellation, { serviceOrderId: orderId, actor: actor.role as unknown as CancelActor, actorUserId: actor.id, reason: body.reason, stateAtCancel: from, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE }));
      await manager.update(TechnicianAssignment, { serviceOrderId: orderId, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: body.reason });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: arrived ? 'CANCELLATION_REQUIRES_REVIEW' : 'ORDER_CANCEL', resourceType: 'service_order', resourceId: orderId, after: { reason: body.reason, strikeApplied: false } });
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }


  async uploadEvidence(orderId: string, body: { type: EvidenceType; note?: string; capturedAt?: string }, actor: { id: string; role: string }, file?: EvidenceFile): Promise<RepairEvidence> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      const expected = body.type === EvidenceType.BEFORE ? ServiceOrderStatus.EN_ROUTE : ServiceOrderStatus.UNDER_REPAIR;
      if (order.status !== expected || order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Evidence timing is invalid');
      if (body.type === EvidenceType.BEFORE && !await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Valid arrival required before BEFORE evidence');
      const count = await manager.count(RepairEvidence, { where: { serviceOrderId: orderId, type: body.type } });
      const max = await this.configService.getInt('evidence.max_count_per_type', 20);
      if (count >= max) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Evidence limit exceeded');
      if (body.capturedAt && new Date(body.capturedAt) > new Date()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Evidence timestamp cannot be in the future');
      this.evidenceStorage.validate(file);
      const mediaUrl = await this.evidenceStorage.upload(orderId, actor.id, file);
      return manager.save(RepairEvidence, manager.create(RepairEvidence, { serviceOrderId: orderId, uploaderId: actor.id, type: body.type, mediaUrl, mimeType: file.mimetype, fileSize: file.size, note: body.note || null, capturedAt: body.capturedAt ? new Date(body.capturedAt) : new Date() }));
    });
  }


  async getEvidence(
    orderId: string,
    actor: { id: string; role: string },
  ): Promise<RepairEvidence[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    const evidence = await this.evidenceRepo.find({ where: { serviceOrderId: orderId }, order: { createdAt: 'ASC' } });
    return Promise.all(evidence.map(async item => ({ ...item, mediaUrl: await this.evidenceStorage.signedUrl(item.mediaUrl) })));
  }

  /**
   * Get status history for an order (D-22 audit trail).
   */
  async getStatusHistory(orderId: string, actor: { id: string; role: string }): Promise<OrderStatusHistory[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.historyRepo.find({
      where: { serviceOrderId: orderId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Finance delegates keep the existing Service Orders public surface while
   * keeping money-state authority in the Finance module.
   */
  async getInvoice(
    orderId: string,
    actor: FinanceActor,
  ): Promise<InvoiceResponseDto | null> {
    return this.financeService.getInvoice(orderId, actor);
  }

  async payInvoice(
    invoiceId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.financeService.initiateInvoicePayment(invoiceId, actor, dto);
  }

  async createInvoiceVnpayUrl(
    invoiceId: string,
    actor: FinanceActor,
    ipAddr: string,
  ): Promise<{ paymentUrl: string }> {
    return this.financeService.createVnpayPaymentUrl(invoiceId, actor, ipAddr);
  }


  async getWarranties(orderId: string, actor: { id: string; role: string }): Promise<WarrantyCoverage[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.warrantyRepo.find({
      where: { serviceOrderId: orderId },
      order: { expiresAt: 'ASC' },
    });
  }

  // ── Spec v1.2: Cash Settlement & Commission Tracking ──

  async declareCashSettlement(
    orderId: string,
    dto: CashSettlementDeclarationDto,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto> {
    return this.financeService.declareCashSettlement(orderId, dto, actor);
  }

  async confirmCashSettlement(
    orderId: string,
    dto: CashSettlementConfirmationDto,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto> {
    return this.financeService.confirmCashSettlement(orderId, dto, actor);
  }

  async getCashSettlement(
    orderId: string,
    actor: FinanceActor,
  ): Promise<CashSettlementResponseDto | null> {
    return this.financeService.getCashSettlement(orderId, actor);
  }

  async getCommissionDues(
    actor: FinanceActor,
  ): Promise<{ data: CommissionDueResponseDto[]; totalDue: number }> {
    return this.financeService.getCommissionDues(actor);
  }

  async payCommissionDue(
    dueId: string,
    actor: FinanceActor,
    dto: InitiatePaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.financeService.initiateCommissionDuePayment(dueId, actor, dto);
  }


  async createWarrantyClaim(
    orderId: string,
    dto: { description: string },
    customer: { id: string },
  ): Promise<WarrantyClaim> {
    if (!dto.description?.trim()) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Vui lòng cung cấp mô tả chi tiết sự cố bảo hành');
    }
    const order = await this.orderRepo.findOneBy({ id: orderId });
    if (!order) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
    }
    if (order.status !== ServiceOrderStatus.COMPLETED) {
      throw new BusinessException(
        ErrorCodes.ORDER_INVALID_TRANSITION,
        'Chỉ đơn hàng đã hoàn tất (COMPLETED) mới được yêu cầu bảo hành',
      );
    }
    const booking = await this.dataSource
      .getRepository(Booking)
      .findOneBy({ id: order.bookingId });
    if (booking?.customerId !== customer.id) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Only customer can submit warranty claim',
      );
    }

    // Validate that order has active and non-expired warranty coverage
    const coverages = await this.warrantyRepo.find({
      where: { serviceOrderId: orderId, status: WarrantyStatus.ACTIVE },
    });
    const validCoverages = coverages.filter((c) => new Date(c.expiresAt) > new Date());
    if (validCoverages.length === 0) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Đơn hàng không có gói bảo hành nào còn hiệu lực hoặc thời hạn bảo hành đã kết thúc',
      );
    }

    // Check for duplicate active claim
    const existingActiveClaim = await this.warrantyClaimRepo.findOne({
      where: {
        serviceOrderId: orderId,
        status: In([
          WarrantyClaimStatus.SUBMITTED,
          WarrantyClaimStatus.ACCEPTED,
          WarrantyClaimStatus.IN_PROGRESS,
        ]),
      },
    });
    if (existingActiveClaim) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Đơn hàng này đang có một yêu cầu bảo hành đang được xử lý',
      );
    }

    const assignment = await this.assignmentRepo.findOne({
      where: { serviceOrderId: orderId, isActive: true },
    });

    const claim = this.warrantyClaimRepo.create({
      serviceOrderId: orderId,
      customerId: customer.id,
      technicianId: assignment?.technicianId || '',
      description: dto.description.trim(),
      status: WarrantyClaimStatus.SUBMITTED,
    });
    return this.warrantyClaimRepo.save(claim);
  }

  async getWarrantyClaims(orderId: string, actor: { id: string; role: string }): Promise<WarrantyClaim[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.warrantyClaimRepo.find({
      where: { serviceOrderId: orderId },
      relations: ['customer', 'technician'],
      order: { submittedAt: 'DESC' },
    });
  }

  /**
   * Get cancellations for SM/Admin board.
   */
  async getCancellations(options: {
    page?: number;
    limit?: number;
  }): Promise<{ data: Cancellation[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const [data, total] = await this.cancellationRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  /**
   * Review cancellation — waive strike, decide compensation.
   */
  async reviewCancellation(
    cancellationId: string,
    body: {
      waiveStrike?: boolean;
      waiveReason?: string;
      compensationDecision?: 'GRANTED' | 'REJECTED';
      grantPriorityBoost?: boolean;
    },
    actor: { id: string; role: string },
  ): Promise<Cancellation> {
    if (![Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role)) throw new ForbiddenException('Staff review required');
    if (body.compensationDecision === 'GRANTED') throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Monetary cancellation compensation is not supported by MASTER v1.4');
    const cancellation = await this.cancellationRepo.findOneBy({
      id: cancellationId,
    });
    if (!cancellation) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Cancellation not found');
    }

    cancellation.reviewedByUserId = actor.id;

    if (body.compensationDecision) {
      cancellation.compensationStatus = CompensationStatus.REJECTED;
    }

    // Spec v1.2: Grant Priority Boost to technician if requested
    if (body.grantPriorityBoost) {
      const assignment = await this.assignmentRepo.findOne({
        where: { serviceOrderId: cancellation.serviceOrderId },
        order: { createdAt: 'DESC' },
      });
      if (assignment) {
        const boostDays = await this.configService.getInt('priority_boost.duration_days', 7);
        const boostUntil = new Date(Date.now() + boostDays * 24 * 60 * 60 * 1000);
        await this.techProfileRepo.update(
          { userId: assignment.technicianId },
          { priorityBoostUntil: boostUntil },
        );
      }
    }

    if (body.waiveStrike && cancellation.strikeApplied) {
      // Waive the strike
      const strike = await this.strikeRepo.findOne({
        where: { cancellationId: cancellation.id, status: StrikeStatus.ACTIVE },
      });
      if (strike) {
        strike.status = StrikeStatus.WAIVED;
        strike.waivedByUserId = actor.id;
        strike.waiveReason = body.waiveReason || 'Waived by manager';
        await this.strikeRepo.save(strike);
      }
    }

    const saved = await this.cancellationRepo.save(cancellation);

    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'CANCELLATION_REVIEW',
      resourceType: 'cancellation',
      resourceId: cancellationId,
      after: body,
    });

    return saved;
  }

  /**
   * Get strikes for a user.
   */
  async getStrikes(options: {
    userId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: CancellationStrike[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.strikeRepo.createQueryBuilder('s');
    if (options.userId) {
      qb.where('s.userId = :userId', { userId: options.userId });
    }

    qb.orderBy('s.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /**
   * Waive a strike.
   */
  async waiveStrike(
    strikeId: string,
    body: { reason: string },
    actor: { id: string; role: string },
  ): Promise<CancellationStrike> {
    const strike = await this.strikeRepo.findOneBy({ id: strikeId });
    if (!strike) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Strike not found');
    }

    strike.status = StrikeStatus.WAIVED;
    strike.waivedByUserId = actor.id;
    strike.waiveReason = body.reason;

    const saved = await this.strikeRepo.save(strike);

    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'STRIKE_WAIVE',
      resourceType: 'cancellation_strike',
      resourceId: strikeId,
      after: { reason: body.reason },
    });

    return saved;
  }

  /**
   * D-20: Repair history — read model derived from service_orders + invoices + reviews.
   * NO separate table.
   */
  async getRepairHistory(
    userId: string,
    role: string,
    options: { page?: number; limit?: number },
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .leftJoinAndSelect('bookings', 'b', 'b.id = o.booking_id')
      .leftJoinAndSelect('services', 's', 's.id = b.service_id')
      .where('o.status IN (:...terminal)', { terminal: [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED] });

    if (role === Role.CUSTOMER) {
      qb.andWhere('b.customer_id = :userId', { userId });
    } else if (role === Role.TECHNICIAN) {
      qb.innerJoin(
        'technician_assignments',
        'ta',
        'ta.service_order_id = o.id',
      ).andWhere('ta.technician_id = :userId', { userId });
    }

    qb.orderBy('o.completedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    // Return as plain objects matching the read model
    const result = await Promise.all(data.map(async order => {
      const booking = await this.dataSource.manager.findOneBy(Booking, { id: order.bookingId });
      const assignment = await this.assignmentRepo.findOne({ where: { serviceOrderId: order.id }, order: { assignedAt: 'DESC' } });
      const technician = assignment ? await this.userRepo.findOneBy({ id: assignment.technicianId }) : null;
      return {
        orderId: order.id, bookingId: order.bookingId, code: order.code, status: order.status,
        serviceName: booking?.serviceNameSnapshot, technicianName: technician?.fullName,
        addressSummary: booking?.addressTextSnapshot,
        laborTotal: Number(order.laborTotal), partsTotal: Number(order.partsTotal), grandTotal: Number(order.grandTotal),
        completedAt: order.completedAt, cancelledAt: order.cancelledAt,
      };
    }));

    return { data: result, total };
  }

  // ── Private helpers ──

  /**
   * D-22: Central method for state transitions within a transaction.
   */
  private async transitionStatus(orderId: string, nextStatus: ServiceOrderStatus, actor: { id: string; role: string }, reason?: string): Promise<ServiceOrder> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (nextStatus === ServiceOrderStatus.UNDER_REPAIR) {
        const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
        if (!await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Valid arrival required');
        const required = await this.configService.getInt('evidence.before.min_count', 1);
        if (await manager.count(RepairEvidence, { where: { serviceOrderId: orderId, type: EvidenceType.BEFORE, uploaderId: actor.id } }) < required) throw new BusinessException(ErrorCodes.EVIDENCE_REQUIRED_BEFORE, 'BEFORE evidence required');
        if (booking.pricingModeSnapshot !== ServicePricingMode.FIXED_PRICE && !await manager.findOneBy(Quotation, { serviceOrderId: orderId, technicianId: actor.id, status: QuotationStatus.APPROVED })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Approved official quotation required');
        if (booking.pricingModeSnapshot === ServicePricingMode.FIXED_PRICE && booking.fixedUnitPriceSnapshot == null) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Fixed price snapshot missing');
        if (await manager.count(AdditionalCostRequest, { where: { serviceOrderId: orderId, status: AdditionalCostStatus.PENDING_APPROVAL } })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Additional approval required');
      }
      await this.commitTransition(manager, order, nextStatus, actor, reason || 'Order progress');
      return manager.findOneByOrFail(ServiceOrder, { id: orderId });
    });
  }

  private async commitTransition(manager: EntityManager, order: ServiceOrder, next: ServiceOrderStatus, actor: { id: string; role: string }, reason: string): Promise<void> {
    if (!ServiceOrderStateMachine.canTransition(order.status, next)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Illegal order transition');
    const previous = order.status;
    const now = new Date();
    await manager.update(ServiceOrder, order.id, { status: next, ...(next === ServiceOrderStatus.UNDER_REPAIR ? { startedAt: now } : {}), ...(next === ServiceOrderStatus.COMPLETED ? { completedAt: now } : {}), ...(next === ServiceOrderStatus.CANCELLED ? { cancelledAt: now } : {}) });
    await manager.insert(OrderStatusHistory, { serviceOrderId: order.id, fromStatus: previous, toStatus: next, actorUserId: actor.id, actorRole: actor.role, reason });
    await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ORDER_TRANSITION', resourceType: 'service_order', resourceId: order.id, before: { status: previous }, after: { status: next, reason } });
    order.status = next;
  }

  private async assertCompletionReady(manager: EntityManager, order: ServiceOrder): Promise<void> {
    await expireAdditionalCosts(manager, order.id);
    const required = await this.configService.getInt('evidence.after.min_count', 1);
    if (await manager.count(RepairEvidence, { where: { serviceOrderId: order.id, type: EvidenceType.AFTER } }) < required) throw new BusinessException(ErrorCodes.EVIDENCE_REQUIRED_AFTER, 'AFTER evidence required');
    if (await manager.count(AdditionalCostRequest, { where: { serviceOrderId: order.id, status: AdditionalCostStatus.PENDING_APPROVAL } }) || await manager.count(Quotation, { where: { serviceOrderId: order.id, status: QuotationStatus.SENT } })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Pending financial approval');
    const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
    if (booking.pricingModeSnapshot !== ServicePricingMode.FIXED_PRICE && !await manager.findOneBy(Quotation, { serviceOrderId: order.id, status: QuotationStatus.APPROVED })) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Approved quotation required');
  }

  private async finalizeIfSatisfied(manager: EntityManager, order: ServiceOrder, actor: { id: string; role: string }): Promise<boolean> {
    if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) return false;
    await this.assertCompletionReady(manager, order);
    if (!await manager.findOneBy(CustomerServiceConfirmation, { serviceOrderId: order.id })) return false;
    const invoice = await manager.findOneBy(Invoice, { serviceOrderId: order.id, paymentStatus: PaymentStatus.PAID });
    if (!invoice || order.paymentStatus !== PaymentStatus.PAID) return false;
    await this.commitTransition(manager, order, ServiceOrderStatus.COMPLETED, actor, 'Work, customer confirmation and payment satisfied');
    const items = await manager.find(InvoiceItem, { where: { invoiceId: invoice.id } });
    for (const item of items) {
      if (item.warrantyDaysSnapshot <= 0 || (item.partSource === PartSource.TECHNICIAN && item.partWarrantyOption !== PartWarrantyOption.PAID_WARRANTY)) continue;
      await manager.insert(WarrantyCoverage, { serviceOrderId: order.id, invoiceItemId: item.id, warrantyDaysSnapshot: item.warrantyDaysSnapshot, startsAt: new Date(), expiresAt: new Date(Date.now() + item.warrantyDaysSnapshot * 86400000), status: WarrantyStatus.ACTIVE });
    }
    return true;
  }


  private async generateInvoice(
    orderId: string,
    manager: EntityManager,
  ): Promise<Invoice> {
    const existing = await manager.findOneBy(Invoice, { serviceOrderId: orderId });
    if (existing) return existing;
    const order = await manager.findOne(ServiceOrder, { where: { id: orderId } });

    const booking = order
      ? await manager.findOne(Booking, {
          where: { id: order.bookingId },
          relations: ['service'],
        })
      : null;

    // Get approved quotation (if any)
    const quotation = await manager.findOne(Quotation, {
      where: { serviceOrderId: orderId, status: QuotationStatus.APPROVED },
      relations: ['items'],
    });

    // Get approved additional costs
    const additionalCosts = await manager.find(AdditionalCostRequest, {
      where: {
        serviceOrderId: orderId,
        status: AdditionalCostStatus.APPROVED,
      },
    });
    const additionalCostIds = additionalCosts.map((ac) => ac.id);
    let additionalItems: AdditionalCostItem[] = [];
    if (additionalCostIds.length > 0) {
      additionalItems = await manager
        .createQueryBuilder(AdditionalCostItem, 'aci')
        .where('aci.request_id IN (:...ids)', { ids: additionalCostIds })
        .getMany();
    }

    // Calculate totals
    let laborTotal = 0;
    let fixHomePartsTotal = 0;
    let technicianPartsTotal = 0;
    let technicianPartWarrantyFeeTotal = 0;

    const invoiceItems: Partial<InvoiceItem>[] = [];

    // 1. Check if FIXED_PRICE booking
    const isFixedPrice =
      booking?.pricingModeSnapshot === ServicePricingMode.FIXED_PRICE ||
      (!quotation && booking?.fixedUnitPriceSnapshot != null);

    if (isFixedPrice && booking) {
      const unitPrice = Number(booking.fixedUnitPriceSnapshot);
      const quantity = Math.max(1, Number(booking.quantity || 1));
      const lineTotal = unitPrice * quantity;
      laborTotal += lineTotal;

      invoiceItems.push({
        sourceType: 'FIXED_PRICE',
        sourceItemId: booking.id,
        type: CostItemType.LABOR,
        description:
          booking.scopeSnapshot ||
          booking.service?.name ||
          'Fixed Price Labor Package',
        quantity,
        unitPrice,
        lineTotal,
        warrantyDaysSnapshot: 0,
      });
    }

    if (!isFixedPrice && quotation?.items) {
      // 2. Inspection-based quotation items
      for (const qi of quotation.items) {
        const lineTotal = Number(qi.lineTotal);
        if (qi.type === CostItemType.LABOR) {
          laborTotal += lineTotal;
        } else {
          if (qi.partSource === PartSource.FIXHOME) {
            fixHomePartsTotal += lineTotal;
          } else {
            technicianPartsTotal += lineTotal;
          }
          if (qi.warrantyFee) {
            technicianPartWarrantyFeeTotal += Number(qi.warrantyFee);
          }
        }

        invoiceItems.push({
          sourceType: 'QUOTATION',
          sourceItemId: qi.id,
          type: qi.type,
          description: qi.description,
          quantity: qi.quantity,
          unitPrice: Number(qi.unitPrice),
          lineTotal,
          warrantyDaysSnapshot: qi.partSource === PartSource.TECHNICIAN ? (qi.partWarrantyOption === PartWarrantyOption.PAID_WARRANTY ? qi.warrantyTermDays ?? 0 : 0) : qi.warrantyDaysSnapshot,
          partSource: qi.partSource || null,
          partWarrantyOption: qi.partWarrantyOption || null,
          warrantyFee: qi.warrantyFee || null,
        });
      }
    }

    // 3. Approved Additional cost items
    for (const aci of additionalItems) {
      const lineTotal = Number(aci.lineTotal);
      if (aci.type === CostItemType.LABOR) {
        laborTotal += lineTotal;
      } else {
        if (aci.partSource === PartSource.FIXHOME) {
          fixHomePartsTotal += lineTotal;
        } else {
          technicianPartsTotal += lineTotal;
        }
        if (aci.warrantyFee) {
          technicianPartWarrantyFeeTotal += Number(aci.warrantyFee);
        }
      }

      invoiceItems.push({
        sourceType: 'ADDITIONAL',
        sourceItemId: aci.id,
        type: aci.type,
        description: aci.description,
        quantity: aci.quantity,
        unitPrice: Number(aci.unitPrice),
        lineTotal,
        warrantyDaysSnapshot: aci.partSource === PartSource.TECHNICIAN ? (aci.partWarrantyOption === PartWarrantyOption.PAID_WARRANTY ? aci.warrantyTermDays ?? 0 : 0) : aci.warrantyDays,
        partSource: aci.partSource || null,
        partWarrantyOption: aci.partWarrantyOption || null,
        warrantyFee: aci.warrantyFee || null,
      });
    }

    const partsTotal = fixHomePartsTotal + technicianPartsTotal;
    const grandTotal = laborTotal + partsTotal + technicianPartWarrantyFeeTotal;

    // Spec v1.4 BRX-026: Platform commission is 10% on Final Labor Total. 0% on parts. Rate snapshotted.
    const commissionBase = 'LABOR';
    const commissionRateSnapshot = (await this.configService.getInt('commission.rate_bps', 1000)) / 10000;
    if (commissionRateSnapshot < 0 || commissionRateSnapshot > 1) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid commission configuration');
    const commissionAmount = Math.round(laborTotal * commissionRateSnapshot);

    // Create invoice
    const invoice = manager.create(Invoice, {
      serviceOrderId: orderId,
      laborTotal,
      partsTotal,
      fixHomePartsTotal,
      technicianPartsTotal,
      technicianPartWarrantyFeeTotal,
      grandTotal,
      commissionBase,
      commissionRateSnapshot,
      commissionAmount,
      paymentStatus: PaymentStatus.UNPAID,
      issuedAt: new Date(),
    });
    const savedInvoice = await manager.save(Invoice, invoice);

    // Create invoice items
    for (const item of invoiceItems) {
      item.invoiceId = savedInvoice.id;
      await manager.insert(InvoiceItem, item);

    }

    // Update order totals
    await manager.update(ServiceOrder, orderId, {
      laborTotal,
      partsTotal,
      grandTotal,
    });

    return savedInvoice;
  }

  /**
   * Check if user has exceeded strike threshold → apply suspension.
   */
  private async checkStrikeThreshold(
    userId: string,
    role: string,
    manager: EntityManager,
  ): Promise<void> {
    const thresholdKey =
      role === Role.CUSTOMER
        ? 'strike.customer.threshold'
        : 'strike.technician.threshold';
    const suspensionKey =
      role === Role.CUSTOMER
        ? 'customer.suspension.hours'
        : 'technician.suspension.hours';

    const threshold = await this.configService.getInt(thresholdKey, 2);
    const suspensionHours = await this.configService.getInt(suspensionKey, 72);

    const activeStrikes = await manager.count(CancellationStrike, {
      where: { userId, status: StrikeStatus.ACTIVE },
    });

    if (activeStrikes >= threshold) {
      const suspendedUntil = new Date(
        Date.now() + suspensionHours * 60 * 60 * 1000,
      );

      if (role === Role.CUSTOMER) {
        await manager.update(User, userId, {
          bookingSuspendedUntil: suspendedUntil,
        });
      } else if (role === Role.TECHNICIAN) {
        await manager.update(
          TechnicianProfile,
          { userId },
          { workSuspendedUntil: suspendedUntil },
        );
      }

      this.logger.warn(
        `User ${userId} suspended until ${suspendedUntil.toISOString()} (${activeStrikes} active strikes)`,
      );
    }
  }

  /**
   * Check if an actor has access to a specific order.
   */
  private async checkOrderAccess(order: ServiceOrder, actor: { id: string; role: string }): Promise<void> {
    await authorizeOrder(this.dataSource.manager, order.id, actor);
  }


}

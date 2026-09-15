// src/modules/service-orders/service-orders.service.ts
import { Injectable, Logger, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
import { CashSettlement } from './entities/cash-settlement.entity';
import { CommissionDue } from './entities/commission-due.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { CustomerServiceConfirmation } from './entities/customer-service-confirmation.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { ServiceOrderStateMachine } from './service-order-state-machine';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  ServiceOrderStatus,
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
  CashSettlementStatus,
  CommissionDueStatus,
  WarrantyClaimStatus,
  PartSource,
  PartWarrantyOption,
} from '../../shared/enums';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { EntityManager } from 'typeorm';
import { OrderEvidenceStorage, EvidenceFile } from '../media/order-evidence-storage.service';
import { authorizeOrder } from './order-access';

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
    @InjectRepository(CashSettlement)
    private readonly cashSettlementRepo: Repository<CashSettlement>,
    @InjectRepository(CommissionDue)
    private readonly commissionDueRepo: Repository<CommissionDue>,
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
  ) {}

  // ── Queries ──

  async findAll(options: {
    page?: number;
    limit?: number;
    status?: ServiceOrderStatus;
    search?: string;
  }): Promise<{ data: ServiceOrder[]; total: number }> {
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
  ): Promise<{ data: ServiceOrder[]; total: number }> {
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
    }

    if (options.status) {
      qb.andWhere('o.status = :status', { status: options.status });
    }

    qb.orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data: await Promise.all(data.map(order => this.presentOrder(order))), total };
  }

  async findById(
    id: string,
    actor: { id: string; role: string },
  ): Promise<ServiceOrder> {
    const order = await this.orderRepo.findOneBy({ id });
    if (!order) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Order not found');
    }
    await this.checkOrderAccess(order, actor);
    return this.presentOrder(order);
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
      pricingMode: booking.pricingModeSnapshot, customerName: customer?.fullName || '', customerPhone: customer?.phoneNumber || '',
      technician: technician ? { id: technician.id, fullName: technician.fullName, phoneNumber: technician.phoneNumber } : undefined,
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
      const rad = (v: number) => v * Math.PI / 180;
      const lat = Number(booking.latitudeSnapshot), lng = Number(booking.longitudeSnapshot);
      const a = Math.sin(rad(body.lat-lat)/2)**2 + Math.cos(rad(lat))*Math.cos(rad(body.lat))*Math.sin(rad(body.lng-lng)/2)**2;
      const distanceMeters = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1-a))));
      const radius = await this.configService.getInt('geofence.radius_meters', 300);
      const accuracy = await this.configService.getInt('geofence.min_gps_accuracy_meters', 100);
      const result = body.accuracyMeters > accuracy ? CheckInResult.LOW_ACCURACY : distanceMeters > radius ? CheckInResult.OUT_OF_GEOFENCE : CheckInResult.VALID;
      return manager.save(ArrivalCheckIn, manager.create(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, lat: body.lat, lng: body.lng, accuracyMeters: body.accuracyMeters, distanceMeters, result, checkedInAt: new Date(), deviceInfo: body.deviceInfo || null }));
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
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, actor.role === Role.TECHNICIAN ? 'technician' : 'read', true);
      if (order.status === ServiceOrderStatus.CANCELLED) return order;
      const arrived = await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, result: CheckInResult.VALID });
      if (actor.role === Role.TECHNICIAN && arrived) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'After arrival, request Service Manager exception handling');
      if (actor.role === Role.CUSTOMER && order.status === ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'During repair, request Service Manager exception handling');
      const from = order.status;
      await this.commitTransition(manager, order, ServiceOrderStatus.CANCELLED, actor, body.reason);
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
      return manager.save(RepairEvidence, manager.create(RepairEvidence, { serviceOrderId: orderId, uploaderId: actor.id, type: body.type, mediaUrl, note: body.note || null, capturedAt: body.capturedAt ? new Date(body.capturedAt) : new Date() }));
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
   * Get invoice for an order.
   */
  async getInvoice(orderId: string, actor: { id: string; role: string }): Promise<Invoice | null> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.invoiceRepo.findOne({
      where: { serviceOrderId: orderId },
      relations: ['items'],
    });
  }

  /**
   * Pay invoice (DEMO mode — just mark as PAID).
   */
  async payInvoice(invoiceId: string, actor: { id: string; role: string }): Promise<Invoice> {
    const invoice = await this.invoiceRepo.findOneBy({ id: invoiceId });
    if (!invoice) throw new ForbiddenException('Invoice not found');
    await authorizeOrder(this.dataSource.manager, invoice.serviceOrderId, actor, 'customer');
    throw new NotImplementedException('Verified online payment provider is not connected. Use cash dual confirmation.');
  }


  async getWarranties(orderId: string, actor: { id: string; role: string }): Promise<WarrantyCoverage[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.warrantyRepo.find({
      where: { serviceOrderId: orderId },
      order: { expiresAt: 'ASC' },
    });
  }

  // ── Spec v1.2: Cash Settlement & Commission Tracking ──

  async declareCashSettlement(orderId: string, dto: { declaredAmount: number; technicianNotes?: string; receiptEvidenceUrl?: string }, actor: { id: string; role: string }): Promise<CashSettlement> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Completion request and final invoice required before cash declaration');
      if (!Number.isFinite(dto.declaredAmount) || dto.declaredAmount < 0) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid cash amount');
      const invoice = await manager.findOneBy(Invoice, { serviceOrderId: orderId });
      if (!invoice || invoice.paymentStatus === PaymentStatus.PAID) throw new BusinessException(ErrorCodes.CONFLICT, 'Invoice unavailable or already paid');
      let settlement = await manager.findOneBy(CashSettlement, { serviceOrderId: orderId });
      if (settlement) {
        if (Number(settlement.declaredAmount) === dto.declaredAmount && settlement.status === CashSettlementStatus.PENDING_CONFIRMATION) return settlement;
        throw new BusinessException(ErrorCodes.CONFLICT, 'Cash declaration already exists; disputed amounts require Manager resolution');
      }
      settlement = manager.create(CashSettlement, { serviceOrderId: orderId, declaredByTechnicianId: actor.id, declaredAmount: dto.declaredAmount, declaredAt: new Date(), technicianNotes: dto.technicianNotes || null, receiptEvidenceUrl: dto.receiptEvidenceUrl || null, status: CashSettlementStatus.PENDING_CONFIRMATION });
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'CASH_DECLARED', resourceType: 'service_order', resourceId: orderId, after: { declaredAmount: dto.declaredAmount } });
      return manager.save(settlement);
    });
  }


  async confirmCashSettlement(orderId: string, dto: { agreed: boolean; disputeReason?: string; confirmedAmount?: number }, actor: { id: string; role: string }): Promise<CashSettlement> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'customer', true);
      const settlement = await manager.findOneBy(CashSettlement, { serviceOrderId: orderId });
      if (!settlement) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Cash declaration not found');
      if (settlement.status === CashSettlementStatus.CONFIRMED && dto.agreed && (dto.confirmedAmount == null || dto.confirmedAmount === Number(settlement.confirmedAmount))) return settlement;
      if (settlement.status !== CashSettlementStatus.PENDING_CONFIRMATION) throw new BusinessException(ErrorCodes.CONFLICT, 'Cash decision already resolved');
      if (order.status !== ServiceOrderStatus.UNDER_REPAIR || !order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Order is not awaiting payment');
      const invoice = await manager.findOneByOrFail(Invoice, { serviceOrderId: orderId });
      const amount = dto.confirmedAmount ?? Number(settlement.declaredAmount);
      const matches = Number(settlement.declaredAmount) === Number(invoice.grandTotal) && amount === Number(invoice.grandTotal);
      settlement.confirmedByCustomerId = actor.id;
      settlement.confirmedAmount = amount;
      settlement.confirmedAt = new Date();
      if (!dto.agreed || !matches) {
        settlement.status = CashSettlementStatus.DISPUTED;
        settlement.managerResolutionReason = dto.disputeReason || 'Cash amount does not match final invoice';
        await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'CASH_DISPUTED', resourceType: 'service_order', resourceId: orderId });
        return manager.save(settlement);
      }
      settlement.status = CashSettlementStatus.CONFIRMED;
      const saved = await manager.save(settlement);
      await manager.update(Invoice, invoice.id, { paymentStatus: PaymentStatus.PAID, paidAt: new Date() });
      await manager.update(ServiceOrder, orderId, { paymentStatus: PaymentStatus.PAID });
      order.paymentStatus = PaymentStatus.PAID;
      // Same User lock as Accept: new due and job acceptance have one serial order.
      await manager.findOne(User, { where: { id: settlement.declaredByTechnicianId }, lock: { mode: 'pessimistic_write' } });
      const dueAmount = Number(invoice.commissionAmount) + Number(invoice.fixHomePartsTotal);
      if (dueAmount > 0 && !await manager.findOneBy(CommissionDue, { serviceOrderId: orderId })) {
        await manager.save(CommissionDue, manager.create(CommissionDue, { technicianId: settlement.declaredByTechnicianId, serviceOrderId: orderId, cashSettlementId: saved.id, laborTotalSnapshot: Number(invoice.laborTotal), commissionRateSnapshot: Number(invoice.commissionRateSnapshot), dueAmount, status: CommissionDueStatus.PENDING }));
      }
      await this.finalizeIfSatisfied(manager, order, actor);
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'CASH_CONFIRMED', resourceType: 'service_order', resourceId: orderId, after: { amount, dueAmount } });
      return saved;
    });
  }


  async getCashSettlement(orderId: string, actor: { id: string; role: string }): Promise<CashSettlement | null> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.cashSettlementRepo.findOne({
      where: { serviceOrderId: orderId },

    });
  }

  async getCommissionDues(
    technicianId: string,
  ): Promise<{ data: CommissionDue[]; totalDue: number }> {
    const dues = await this.commissionDueRepo.find({
      where: { technicianId },
      relations: ['serviceOrder'],
      order: { createdAt: 'DESC' },
    });
    const totalDue = dues
      .filter((d) => d.status === CommissionDueStatus.PENDING)
      .reduce((sum, d) => sum + Number(d.dueAmount), 0);
    return { data: dues, totalDue };
  }

  async payCommissionDue(dueId: string, technicianId: string): Promise<CommissionDue> {
    if (!await this.commissionDueRepo.findOneBy({ id: dueId, technicianId })) throw new ForbiddenException('PlatformDue not found');
    throw new NotImplementedException('Verified PlatformDue payment provider is not connected');
  }


  async createWarrantyClaim(
    orderId: string,
    dto: { description: string },
    customer: { id: string },
  ): Promise<WarrantyClaim> {
    const order = await this.orderRepo.findOneBy({ id: orderId });
    if (!order) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Service order not found');
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

    const assignment = await this.assignmentRepo.findOne({
      where: { serviceOrderId: orderId, isActive: true },
    });

    const claim = this.warrantyClaimRepo.create({
      serviceOrderId: orderId,
      customerId: customer.id,
      technicianId: assignment?.technicianId || '',
      description: dto.description,
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
    const cancellation = await this.cancellationRepo.findOneBy({
      id: cancellationId,
    });
    if (!cancellation) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Cancellation not found');
    }

    cancellation.reviewedByUserId = actor.id;

    if (body.compensationDecision) {
      cancellation.compensationStatus =
        body.compensationDecision === 'GRANTED'
          ? CompensationStatus.GRANTED
          : CompensationStatus.REJECTED;
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
    const result = data.map((order) => ({
      orderId: order.id,
      code: order.code,
      laborTotal: Number(order.laborTotal),
      partsTotal: Number(order.partsTotal),
      grandTotal: Number(order.grandTotal),
      completedAt: order.completedAt,
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
    const commissionRateSnapshot = 0.1;
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

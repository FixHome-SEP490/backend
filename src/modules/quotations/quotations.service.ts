import { Injectable, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Quotation } from './entities/quotation.entity';
import { QuotationItem } from './entities/quotation-item.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { Cancellation } from '../service-orders/entities/cancellation.entity';
import { ServiceOrderStateMachine } from '../service-orders/service-order-state-machine';
import { authorizeOrder } from '../service-orders/order-access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { QuotationStatus, AdditionalCostStatus, CostItemType, ServiceOrderStatus, ServicePricingMode, PartSource, PartWarrantyOption, CheckInResult, CancelActor, CompensationStatus } from '../../shared/enums';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateCostItemDto, CreateQuotationDto, CreateAdditionalCostDto } from './quotation.dto';
export { CreateCostItemDto, CreateQuotationDto, CreateAdditionalCostDto } from './quotation.dto';
type Actor = { id: string; role: string };

@Injectable()
export class QuotationsService {
  constructor(
    @InjectRepository(Quotation) private readonly quotationRepo: Repository<Quotation>,
    @InjectRepository(QuotationItem) private readonly quotationItemRepo: Repository<QuotationItem>,
    @InjectRepository(AdditionalCostRequest) private readonly additionalCostRepo: Repository<AdditionalCostRequest>,
    @InjectRepository(AdditionalCostItem) private readonly additionalCostItemRepo: Repository<AdditionalCostItem>,
    @InjectRepository(ServiceOrder) private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(Booking) private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(TechnicianAssignment) private readonly assignmentRepo: Repository<TechnicianAssignment>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private validateItems(items: CreateCostItemDto[]): CreateCostItemDto[] {
    if (!items?.length) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'At least one cost item required');
    return items.map(input => {
      const item = { ...input };
      if (!Object.values(CostItemType).includes(item.type) || !Number.isInteger(item.quantity) || item.quantity < 1 || !Number.isInteger(item.unitPrice) || item.unitPrice < 0 || !item.description?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid cost item');
      if (item.type === CostItemType.LABOR) {
        if (item.partSource || item.partCatalogId || item.partWarrantyOption || item.warrantyFee || item.warrantyTermDays) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Part warranty fields are not allowed on labor');
      } else {
        if (!Object.values(PartSource).includes(item.partSource!)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Part source required');
        // DEV2 Part Catalog is absent: never accept a client-supplied platform price.
        if (item.partSource === PartSource.FIXHOME) throw new NotImplementedException('FixHome Part Catalog authority is not connected');
        if (item.partCatalogId) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Technician parts cannot reference FixHome catalog');
        item.partNameSnapshot = item.partNameSnapshot?.trim() || item.description.trim();
        item.partWarrantyOption ??= PartWarrantyOption.NO_WARRANTY;
        if (item.partWarrantyOption === PartWarrantyOption.PAID_WARRANTY) {
          if (!item.warrantyFee || item.warrantyFee <= 0 || !item.warrantyTermDays || item.warrantyTermDays <= 0) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Paid warranty requires fee and term');
        } else if (item.partWarrantyOption !== PartWarrantyOption.NO_WARRANTY || item.warrantyFee || item.warrantyTermDays || item.warrantyDays) {
          throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Technician parts have no included warranty');
        }
        item.warrantyDays = 0;
      }
      return item;
    });
  }

  async createQuotation(orderId: string, dto: CreateQuotationDto, actor: Actor): Promise<Quotation> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      const booking = await manager.findOneByOrFail(Booking, { id: order.bookingId });
      if (booking.pricingModeSnapshot !== ServicePricingMode.INSPECTION_REQUIRED || order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Official quotation requires inspection service in EN_ROUTE');
      if (!await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: orderId, technicianId: actor.id, result: CheckInResult.VALID })) throw new BusinessException(ErrorCodes.CHECKIN_OUT_OF_GEOFENCE, 'Verified arrival required before quotation');
      if (await manager.findOneBy(Quotation, { serviceOrderId: orderId, status: QuotationStatus.APPROVED })) throw new BusinessException(ErrorCodes.ADDITIONAL_COST_IMMUTABLE, 'Approved base quotation is immutable; use additional costs');
      const items = this.validateItems(dto.items);
      const laborTotal = items.filter(i => i.type === CostItemType.LABOR).reduce((v,i) => v+i.quantity*i.unitPrice,0);
      const partsTotal = items.filter(i => i.type === CostItemType.PARTS_EQUIPMENT).reduce((v,i) => v+i.quantity*i.unitPrice,0);
      const version = await manager.count(Quotation, { where: { serviceOrderId: orderId } }) + 1;
      await manager.update(Quotation, { serviceOrderId: orderId, status: QuotationStatus.SENT }, { status: QuotationStatus.SUPERSEDED });
      const quote = await manager.save(Quotation, manager.create(Quotation, { serviceOrderId: orderId, technicianId: actor.id, status: QuotationStatus.SENT, version, laborTotal, partsTotal, note: dto.note || null, sentAt: new Date() }));
      quote.items = await manager.save(QuotationItem, items.map(item => manager.create(QuotationItem, { ...item, quotationId: quote.id, lineTotal: item.quantity*item.unitPrice, warrantyDaysSnapshot: item.warrantyDays ?? 0 })));
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'QUOTATION_CREATED', resourceType: 'quotation', resourceId: quote.id, after: { version, laborTotal, partsTotal } });
      return quote;
    });
  }

  async findByOrderId(orderId: string, actor: Actor): Promise<Quotation[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.quotationRepo.find({ where: { serviceOrderId: orderId }, relations: ['items'], order: { createdAt: 'DESC' } });
  }
  async findById(id: string, actor: Actor): Promise<Quotation> {
    const quote = await this.quotationRepo.findOne({ where: { id }, relations: ['items'] });
    if (!quote) throw new ForbiddenException('Quotation not found');
    await authorizeOrder(this.dataSource.manager, quote.serviceOrderId, actor);
    return quote;
  }

  async decideQuotation(id: string, action: 'APPROVE' | 'REJECT', actor: Actor, paidWarrantyItemIds: string[] = []): Promise<Quotation> {
    const ref = await this.quotationRepo.findOneBy({ id });
    if (!ref) throw new ForbiddenException('Quotation not found');
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, ref.serviceOrderId, actor, 'customer', true);
      const quote = await manager.findOneOrFail(Quotation, { where: { id }, relations: ['items'] });
      const target = action === 'APPROVE' ? QuotationStatus.APPROVED : QuotationStatus.REJECTED;
      if (!['APPROVE','REJECT'].includes(action)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid decision');
      if (quote.status === target) return quote;
      if (quote.status !== QuotationStatus.SENT || order.status !== ServiceOrderStatus.EN_ROUTE) throw new BusinessException(ErrorCodes.ADDITIONAL_COST_ALREADY_DECIDED, 'Quotation is no longer pending');
      if (action === 'APPROVE') {
        this.selectWarranty(quote.items, paidWarrantyItemIds);
        await manager.save(QuotationItem, quote.items);
        await manager.update(ServiceOrder, order.id, { laborTotal: quote.laborTotal, partsTotal: quote.partsTotal, grandTotal: Number(quote.laborTotal)+Number(quote.partsTotal)+quote.items.reduce((v,i)=>v+Number(i.warrantyFee ?? 0),0) });
      } else {
        await this.closeNoAgreement(manager, order, actor, 'Official quotation rejected; no agreement');
      }
      quote.status = target;
      quote.decidedAt = new Date();
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'QUOTATION_DECISION', resourceType: 'quotation', resourceId: id, after: { action, paidWarrantyItemIds } });
      return manager.save(quote);
    });
  }

  async createAdditionalCost(orderId: string, dto: CreateAdditionalCostDto, actor: Actor): Promise<AdditionalCostRequest> {
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, orderId, actor, 'technician', true);
      return this.saveAdditional(manager, order, dto, actor);
    });
  }

  private async saveAdditional(manager: EntityManager, order: ServiceOrder, dto: CreateAdditionalCostDto, actor: Actor, supersedesId?: string): Promise<AdditionalCostRequest> {
    if (order.status !== ServiceOrderStatus.UNDER_REPAIR || order.completionRequestedAt) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Additional cost requires ongoing repair before completion request');
    if (!dto.reason?.trim()) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Reason required');
    const items = this.validateItems(dto.items);
    const labor = items.filter(i=>i.type===CostItemType.LABOR).reduce((v,i)=>v+i.quantity*i.unitPrice,0);
    const parts = items.filter(i=>i.type===CostItemType.PARTS_EQUIPMENT).reduce((v,i)=>v+i.quantity*i.unitPrice,0);
    const ttl = await this.configService.getInt('additional_cost.ttl_minutes',120);
    const cost = await manager.save(AdditionalCostRequest, manager.create(AdditionalCostRequest, { serviceOrderId: order.id, technicianId: actor.id, status: AdditionalCostStatus.PENDING_APPROVAL, reason: dto.reason, totalLaborDelta: labor, totalPartsDelta: parts, expiresAt: new Date(Date.now()+ttl*60000), supersedesId }));
    cost.items = await manager.save(AdditionalCostItem, items.map(item=>manager.create(AdditionalCostItem, { ...item, requestId: cost.id, lineTotal: item.quantity*item.unitPrice, warrantyDays: item.warrantyDays ?? 0 })));
    await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ADDITIONAL_COST_CREATED', resourceType: 'additional_cost_request', resourceId: cost.id, after: { supersedesId, labor, parts } });
    return cost;
  }

  async findAdditionalCostsByOrderId(orderId: string, actor: Actor): Promise<AdditionalCostRequest[]> {
    await authorizeOrder(this.dataSource.manager, orderId, actor);
    return this.additionalCostRepo.find({ where: { serviceOrderId: orderId }, relations: ['items'], order: { createdAt: 'DESC' } });
  }

  async decideAdditionalCost(id: string, action: 'APPROVE' | 'REJECT', actor: Actor, paidWarrantyItemIds: string[] = []): Promise<AdditionalCostRequest> {
    const ref = await this.additionalCostRepo.findOneBy({ id });
    if (!ref) throw new ForbiddenException('Additional cost not found');
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, ref.serviceOrderId, actor, 'customer', true);
      const cost = await manager.findOneOrFail(AdditionalCostRequest, { where: { id }, relations: ['items'] });
      if (!['APPROVE','REJECT'].includes(action)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid decision');
      const target = action === 'APPROVE' ? AdditionalCostStatus.APPROVED : AdditionalCostStatus.REJECTED;
      if (cost.status === target) return cost;
      if (cost.status !== AdditionalCostStatus.PENDING_APPROVAL || cost.expiresAt <= new Date() || order.status !== ServiceOrderStatus.UNDER_REPAIR || order.completionRequestedAt) throw new BusinessException(ErrorCodes.ADDITIONAL_COST_ALREADY_DECIDED, 'Additional cost is no longer pending');
      if (action === 'APPROVE') {
        this.selectWarranty(cost.items, paidWarrantyItemIds);
        await manager.save(AdditionalCostItem, cost.items);
        await manager.update(ServiceOrder, order.id, { laborTotal: Number(order.laborTotal)+Number(cost.totalLaborDelta), partsTotal: Number(order.partsTotal)+Number(cost.totalPartsDelta), grandTotal: Number(order.grandTotal)+Number(cost.totalLaborDelta)+Number(cost.totalPartsDelta)+cost.items.reduce((v,i)=>v+Number(i.warrantyFee ?? 0),0) });
      }
      cost.status = target;
      cost.decidedAt = new Date();
      cost.decidedByCustomerId = actor.id;
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'ADDITIONAL_COST_DECISION', resourceType: 'additional_cost_request', resourceId: id, after: { action, paidWarrantyItemIds } });
      return manager.save(cost);
    });
  }

  async reviseAdditionalCost(id: string, dto: CreateAdditionalCostDto, actor: Actor): Promise<AdditionalCostRequest> {
    const ref = await this.additionalCostRepo.findOneBy({ id });
    if (!ref) throw new ForbiddenException('Additional cost not found');
    return this.dataSource.transaction(async manager => {
      const order = await authorizeOrder(manager, ref.serviceOrderId, actor, 'technician', true);
      const old = await manager.findOneByOrFail(AdditionalCostRequest, { id });
      if (old.status === AdditionalCostStatus.APPROVED) throw new BusinessException(ErrorCodes.ADDITIONAL_COST_IMMUTABLE, 'Approved cost is immutable');
      const revised = await this.saveAdditional(manager, order, dto, actor, id);
      if (old.status === AdditionalCostStatus.PENDING_APPROVAL) await manager.update(AdditionalCostRequest, id, { status: AdditionalCostStatus.CANCELLED });
      return revised;
    });
  }

  private selectWarranty(items: (QuotationItem | AdditionalCostItem)[], selected: string[]): void {
    if (selected.some(id=>!items.some(i=>i.id===id && i.partSource===PartSource.TECHNICIAN && i.partWarrantyOption===PartWarrantyOption.PAID_WARRANTY))) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid paid warranty selection');
    for (const item of items) {
      if (item.partSource === PartSource.TECHNICIAN && !selected.includes(item.id)) {
        item.partWarrantyOption = PartWarrantyOption.NO_WARRANTY;
        item.warrantyFee = null;
        item.warrantyTermDays = null;
      }
    }
  }

  private async closeNoAgreement(manager: EntityManager, order: ServiceOrder, actor: Actor, reason: string): Promise<void> {
    if (!ServiceOrderStateMachine.canTransition(order.status, ServiceOrderStatus.CANCELLED)) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Cannot close order');
    await manager.update(ServiceOrder, order.id, { status: ServiceOrderStatus.CANCELLED, cancelledAt: new Date() });
    await manager.insert(OrderStatusHistory, { serviceOrderId: order.id, fromStatus: order.status, toStatus: ServiceOrderStatus.CANCELLED, actorUserId: actor.id, actorRole: actor.role, reason });
    await manager.insert(Cancellation, { serviceOrderId: order.id, actor: CancelActor.CUSTOMER, actorUserId: actor.id, reason, stateAtCancel: order.status, strikeApplied: false, compensationStatus: CompensationStatus.NOT_ELIGIBLE });
    await manager.update(TechnicianAssignment, { serviceOrderId: order.id, isActive: true }, { isActive: false, unassignedAt: new Date(), unassignReason: reason });
  }
}

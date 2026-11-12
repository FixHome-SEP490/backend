// src/modules/part-requests/part-requests.service.ts
import { Injectable, Logger, ForbiddenException, Optional, BadRequestException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PartCustodyService } from './part-custody.service';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository, Not } from 'typeorm';
import { WarehouseAllocation } from './entities/warehouse-allocation.entity';
import * as crypto from 'crypto';
import {
  PartRequestStatus,
  PartRequestType,
  FulfillmentMethod,
  PartUsageStatus,
  PartSource,
  Role,
  ServiceOrderStatus,
  QuotationStatus,
  AdditionalCostStatus,
  CostItemType,
  AccountStatus,
  WarrantyClaimStatus,
} from '../../shared/enums';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { authorizeOrder } from '../service-orders/order-access';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PartRequest } from './entities/part-request.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { PartCustody } from './entities/part-custody.entity';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PartRequestStateMachine } from './part-request-state-machine';
import { Quotation } from '../quotations/entities/quotation.entity';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { custodyActivation, custodyUsageForInvoice, lockCustodyTechnician, partReturnsTrackingEnabled } from './part-custody.policy';
import { releaseWarehouseReservations, WarehouseFulfillmentService } from './warehouse-fulfillment.service';
import { WarehouseHandoverDto } from './dto/warehouse-fulfillment.dto';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { WarrantyClaim } from '../service-orders/entities/warranty-claim.entity';
import { WarrantyCostService } from '../service-orders/warranty-cost.service';
import { WarrantyNotifier } from '../service-orders/warranty-notifier.service';
import { partRequestCostSource } from './part-request-lifecycle';
import { MAX_PART_QUANTITY } from './part-custody.rules';
import { WarehouseDeliveryStore } from './warehouse-delivery-store.service';
import { canonicalWarehouseQuantities, hasWholeRequestStock } from './warehouse-fulfillment.rules';
import { partsSourceUnavailable, PartsSourcing, SourcingLine } from './parts-sourcing';
import { isDeepStrictEqual } from 'node:util';
import {
  CreatePartRequestDto,
  ReceivePartRequestDto,
  UpdateItemUsageDto,
  MarkReadyDto,
  FaultyInspectionDto,
  FaultyReturnDto,
  MarkDeliveringDto,
  QueryPartRequestsDto,
} from './dto';

@Injectable()
export class PartRequestsService {
  private readonly logger = new Logger(PartRequestsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PartRequest)
    private readonly partRequestRepo: Repository<PartRequest>,
    @InjectRepository(PartRequestItem)
    private readonly partRequestItemRepo: Repository<PartRequestItem>,
    @InjectRepository(FixHomePart)
    private readonly fixHomePartRepo: Repository<FixHomePart>,
    private readonly auditLogService: AuditLogService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly custodyService?: PartCustodyService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly warehouseFulfillment?: WarehouseFulfillmentService,
  ) {}

  // Resolved lazily: the cost service lives in service-orders and needs wallets, which this module must not import.
  private warrantyCost(): WarrantyCostService | null {
    try { return this.moduleRef?.get(WarrantyCostService, { strict: false }) ?? null; } catch { return null; }
  }

  private async notifyManagersOfReturn(request: PartRequest): Promise<void> {
    try {
      const notifier = this.moduleRef?.get(WarrantyNotifier, { strict: false });
      await notifier?.toManagers(
        'Kỹ thuật viên đã nộp linh kiện hỏng', 'Một yêu cầu bảo hành có linh kiện hỏng đã nộp về kho, cần kiểm tra.',
        'WARRANTY_FAULTY_PART_RETURNED', request.serviceOrderId,
      );
    } catch { /* the notice is a convenience; the return is already recorded */ }
  }

  async warehouseAllocation(requestId: string, actor: { id: string; role: string }) {
    if (![Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN].includes(actor.role as Role)) throw new ForbiddenException();
    await this.getById(requestId, actor);
    return this.warehouseFulfillment!.view(this.dataSource.manager, requestId);
  }

  async warehouseCommand(requestId: string, kind: 'reserve' | 'qr' | 'handover', body: { idempotencyKey: string; qrToken?: string }, actor: { id: string; role: string }) {
    if (![Role.SERVICE_MANAGER, Role.ADMIN].includes(actor.role as Role) || (kind !== 'reserve' && actor.role !== Role.SERVICE_MANAGER)) throw new ForbiddenException();
    return this.dataSource.transaction(async manager => {
      const { request, order } = await this.lockRequest(manager, requestId, actor);
      if (request.requestType === PartRequestType.WARRANTY ||
          [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status) || order.completionRequestedAt) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu bảo hành hoặc đơn đã đóng không thuộc luồng xuất kho W2.');
      }
      if (!await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, technicianId: request.technicianId, isActive: true })) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Kỹ thuật viên không còn phụ trách đơn sửa chữa.');
      }
      if (!await manager.findOne(User, { where: { id: request.technicianId, role: Role.TECHNICIAN, isActive: true, status: AccountStatus.ACTIVE } })) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Kỹ thuật viên không hoạt động; chưa thể cấp linh kiện.');
      }
      if (kind === 'reserve') return this.warehouseFulfillment!.reserve(manager, request, actor, body.idempotencyKey);
      if (kind === 'qr') return this.warehouseFulfillment!.qr(manager, request, actor, body.idempotencyKey);
      return this.warehouseFulfillment!.issue(manager, request, actor, body as WarehouseHandoverDto, async at => {
        const activation = await custodyActivation(manager);
        if (!this.custodyService || !partReturnsTrackingEnabled() || !activation || !activation.activatedAt ||
            !(order.createdAt instanceof Date) || order.createdAt <= activation.activatedAt) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Chưa đủ điều kiện theo dõi trả linh kiện vật lý; chưa xuất kho.');
        }
        await this.custodyService.enrollHandover(manager, { ...request, receivedAt: at }, order);
        const rows = await manager.find(PartCustody, { where: { partRequestId: request.id } });
        if (rows.length !== request.items.length || rows.some(row => !row.trackingOnly || row.technicianId !== request.technicianId)) {
          throw new BusinessException(ErrorCodes.CONFLICT, 'Chưa ghi đủ nghĩa vụ giữ linh kiện; chưa xuất kho.');
        }
      });
    });
  }

  // Always lock the order before its request, matching cancellation and invoicing.
  // Do not lock a LEFT JOIN of items: PostgreSQL forbids locking its nullable side.
  private async lockRequest(manager: EntityManager, id: string, actor: { id: string; role: string }) {
    const reference = await manager.findOne(PartRequest, { where: { id } });
    if (!reference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Part request not found');
    if (reference.requestType === PartRequestType.WARRANTY) return this.lockWarrantyRequest(manager, reference, actor);
    const order = await authorizeOrder(manager, reference.serviceOrderId, actor, 'read', true);
    if ([ServiceOrderStatus.CANCELLED, ServiceOrderStatus.COMPLETED].includes(order.status) || order.completionRequestedAt) {
      throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Parts are immutable after order closure or completion request');
    }
    // Custody commands take Order -> Technician. Take the same order before Request/allocation.
    await lockCustodyTechnician(manager, reference.technicianId);
    const request = await manager.findOneOrFail(PartRequest, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (actor.role === Role.TECHNICIAN && request.technicianId !== actor.id) throw new ForbiddenException('This part request belongs to another technician');
    request.items = await manager.find(PartRequestItem, { where: { partRequestId: id } });
    return { request, order };
  }

  /**
   * A warranty request outlives its completed order, so access follows the claim, not the order:
   * staff, or the technician the claim is assigned to, while the claim is still open.
   */
  private async lockWarrantyRequest(manager: EntityManager, reference: PartRequest, actor: { id: string; role: string }) {
    const claim = reference.warrantyClaimId ? await manager.findOneBy(WarrantyClaim, { id: reference.warrantyClaimId }) : null;
    if (!claim) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Warranty claim not found');
    const staff = [Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role);
    if (!staff && !(actor.role === Role.TECHNICIAN && claim.technicianId === actor.id)) throw new ForbiddenException('Order not found or access denied');
    if ([WarrantyClaimStatus.RESOLVED, WarrantyClaimStatus.REJECTED].includes(claim.status)) {
      throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Warranty claim is closed');
    }
    const order = await manager.findOneOrFail(ServiceOrder, { where: { id: reference.serviceOrderId } });
    const request = await manager.findOneOrFail(PartRequest, { where: { id: reference.id }, lock: { mode: 'pessimistic_write' } });
    request.items = await manager.find(PartRequestItem, { where: { partRequestId: reference.id } });
    return { request, order };
  }

  /**
   * Free FixHome parts for a warranty re-service (PO 04/11/2026). Created in the approval
   * transaction; the claim's technician collects them with the usual READY and QR handover.
   * Who pays the part is decided later by the manager's inspection of the faulty part, which must
   * precede READY. Staff approve; there is no price on the customer's side.
   */
  async createWarrantyRequest(
    manager: EntityManager,
    input: { claim: WarrantyClaim; items: Array<{ partCatalogId: string; quantity: number }>; actor: { id: string; role: string } },
  ): Promise<PartRequest> {
    const { claim, items, actor } = input;
    if (!claim.technicianId) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Warranty claim has no technician');
    if (!items.length) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chọn ít nhất một linh kiện');
    if (await manager.findOneBy(PartRequest, { warrantyClaimId: claim.id })) {
      throw new BusinessException(ErrorCodes.CONFLICT, 'Yêu cầu bảo hành này đã có yêu cầu linh kiện.');
    }
    const merged = new Map<string, number>();
    for (const item of items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_PART_QUANTITY) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Số lượng linh kiện không hợp lệ');
      }
      merged.set(item.partCatalogId, (merged.get(item.partCatalogId) ?? 0) + item.quantity);
    }
    const rows: Partial<PartRequestItem>[] = [];
    for (const [partCatalogId, quantity] of merged) {
      const part = await manager.findOne(FixHomePart, { where: { id: partCatalogId, isActive: true } });
      if (!part) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Approved part is no longer active in FixHome catalog');
      rows.push({
        partCatalogId, partSource: PartSource.FIXHOME, partNameSnapshot: part.name, quantity,
        unitPriceSnapshot: Number(part.sellingPrice), usageStatus: PartUsageStatus.PENDING,
      });
    }
    const request = await manager.save(PartRequest, manager.create(PartRequest, {
      serviceOrderId: claim.serviceOrderId, technicianId: claim.technicianId, requestType: PartRequestType.WARRANTY,
      fulfillmentMethod: FulfillmentMethod.PICKUP, shippingFee: 0, status: PartRequestStatus.REQUESTED,
      warrantyClaimId: claim.id, chargeTechnician: false,
      reason: 'Warranty part: faulty part must be inspected before it is issued',
    }));
    request.items = await manager.save(PartRequestItem, rows.map((row) => ({ ...row, partRequestId: request.id })) as PartRequestItem[]);
    await this.auditLogService.logWithManager(manager, {
      actorUserId: actor.id, actorRole: actor.role, action: 'WARRANTY_PART_REQUEST_CREATED',
      resourceType: 'part_request', resourceId: request.id,
      after: { warrantyClaimId: claim.id, itemCount: rows.length },
    });
    return request;
  }

  /**
   * The faulty part outlives the claim: the technician may bring it back, and the manager inspect it,
   * after the claim closed. Access follows the request's own technician, or staff.
   */
  private async lockWarrantyForFaultyPart(manager: EntityManager, id: string, actor: { id: string; role: string }): Promise<PartRequest> {
    const reference = await manager.findOne(PartRequest, { where: { id } });
    if (!reference) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Part request not found');
    if (reference.requestType !== PartRequestType.WARRANTY) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chỉ yêu cầu linh kiện bảo hành mới có bước linh kiện hỏng.');
    }
    const staff = [Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role);
    if (!staff && !(actor.role === Role.TECHNICIAN && reference.technicianId === actor.id)) throw new ForbiddenException('Order not found or access denied');
    const request = await manager.findOneOrFail(PartRequest, { where: { id }, lock: { mode: 'pessimistic_write' } });
    request.items = await manager.find(PartRequestItem, { where: { partRequestId: id } });
    return request;
  }

  /** The technician brought the faulty part back (PO 05/11/2026). Idempotent: a second call keeps the first record. */
  async returnFaultyPart(requestId: string, dto: FaultyReturnDto, actor: { id: string; role: string }): Promise<PartRequest> {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await this.lockWarrantyForFaultyPart(manager, requestId, actor);
      if (![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(request.status)) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Cần nhận linh kiện thay thế trước khi nộp linh kiện hỏng.');
      }
      if (request.faultyReturnedAt) return { request, fresh: false };
      request.faultyReturnedAt = new Date();
      request.faultyReturnNote = dto.note?.trim() || null;
      const evidence = dto.evidenceRefs?.map((ref) => ref.trim()).filter(Boolean) ?? [];
      request.faultyReturnEvidence = evidence.length ? evidence : null;
      const saved = await manager.save(PartRequest, request);
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id, actorRole: actor.role, action: 'WARRANTY_FAULTY_PART_RETURNED',
        resourceType: 'part_request', resourceId: requestId, after: { returnedAt: saved.faultyReturnedAt },
      });
      return { request: saved, fresh: true };
    });
    if (result.fresh) await this.notifyManagersOfReturn(result.request);
    return this.visible(result.request, actor);
  }

  /**
   * What the manager found on the faulty part (PO 04/11/2026). Installation fault: the technician pays
   * the new part; manufacturer fault and undetermined: FixHome pays. The part must be back first, and the
   * result is recorded once: it moves money, so a change goes through a support case.
   */
  async recordFaultyInspection(requestId: string, dto: FaultyInspectionDto, actor: { id: string; role: string }): Promise<PartRequest> {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await this.lockWarrantyForFaultyPart(manager, requestId, actor);
      if (!request.faultyReturnedAt) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Kỹ thuật viên chưa nộp linh kiện hỏng về kho nên chưa kiểm tra được.');
      }
      if (request.faultyInspectionResult) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Đã ghi kết quả kiểm tra linh kiện hỏng. Muốn đổi, hãy xử lý qua hồ sơ hỗ trợ.');
      }
      const note = dto.note?.trim() ?? '';
      const evidence = dto.evidenceRefs?.map((ref) => ref.trim()).filter(Boolean) ?? [];
      if (dto.result === 'installation' && (note.length < 10 || !evidence.length)) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Kết luận do lắp đặt cần ghi chú và ít nhất một ảnh linh kiện hỏng.');
      }
      request.faultyInspectionResult = dto.result;
      request.faultyInspectionNote = note || null;
      request.faultyInspectionEvidence = evidence.length ? evidence : null;
      request.faultyInspectedAt = new Date();
      request.faultyInspectedBy = actor.id;
      request.chargeTechnician = dto.result === 'installation';
      const saved = await manager.save(PartRequest, request);
      // Installation fault: the technician pays (once, even if the overdue charge already took it).
      // Any other result: a charge taken only for being late is given back.
      await this.warrantyCost()?.chargeForInstallation(manager, saved);
      await this.warrantyCost()?.refundUnreturned(manager, saved);
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id, actorRole: actor.role, action: 'WARRANTY_FAULTY_PART_INSPECTED',
        resourceType: 'part_request', resourceId: requestId,
        after: { result: dto.result, chargeTechnician: saved.chargeTechnician },
      });
      return saved;
    });
  }

  /** The claim closed: a received request is settled, anything not yet handed over is cancelled. */
  async settleWarrantyRequest(manager: EntityManager, claimId: string): Promise<void> {
    const request = await manager.findOne(PartRequest, { where: { warrantyClaimId: claimId }, lock: { mode: 'pessimistic_write' } });
    if (!request || [PartRequestStatus.COMPLETED, PartRequestStatus.CANCELLED].includes(request.status)) return;
    if (request.status === PartRequestStatus.RECEIVED) {
      request.status = PartRequestStatus.COMPLETED;
      request.completedAt = new Date();
    } else {
      request.status = PartRequestStatus.CANCELLED;
      request.cancelledAt = new Date();
    }
    request.qrToken = null;
    await manager.save(PartRequest, request);
  }

  private visible(request: PartRequest, actor: { role: string }): PartRequest {
    // Only the handover operator may retrieve the token. The receiver must obtain it at handover.
    if (actor.role !== Role.SERVICE_MANAGER) request.qrToken = null;
    request.shippingFee = Number(request.shippingFee);
    for (const item of request.items || []) item.unitPriceSnapshot = Number(item.unitPriceSnapshot);
    return request;
  }

  /**
   * Flow 1: Technician creates a Pre-Repair Parts Request
   * - Order must be in ACCEPTED state (before En Route / inspection)
   * - Only one active Pre-Repair request per order (prevent duplicates)
   * - Parts must come from active FixHome Parts Catalog
   * - Pre-Repair parts are NOT charged to the customer at this point
   */
  async createPreRepairRequest(
    orderId: string,
    dto: CreatePartRequestDto,
    actor: { id: string; role: string },
  ): Promise<PartRequest> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // 1. Authorize technician for this order
      const order = await authorizeOrder(
        manager,
        orderId,
        actor,
        'technician',
        true,
      );

      // 2. Validate order status: must be ACCEPTED (before repair)
      if (order.status !== ServiceOrderStatus.ACCEPTED) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          'Pre-repair parts can only be requested when order is in ACCEPTED status',
        );
      }

      // 3. Prevent duplicate active pre-repair requests
      const existingActive = await manager.findOne(PartRequest, {
        where: {
          serviceOrderId: orderId,
          requestType: PartRequestType.PRE_REPAIR,
          status: Not(PartRequestStatus.CANCELLED),
        },
      });

      if (existingActive) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'A pre-repair parts request already exists for this order',
        );
      }

      // 4. Validate and snapshot parts from catalog
      const itemsToInsert: Partial<PartRequestItem>[] = [];
      for (const itemDto of dto.items) {
        const part = await manager.findOne(FixHomePart, {
          where: { id: itemDto.partCatalogId, isActive: true },
        });

        if (!part) {
          throw new BusinessException(
            ErrorCodes.NOT_FOUND,
            `Part not found or inactive in catalog: ${itemDto.partCatalogId}`,
          );
        }

        if (!Number.isSafeInteger(Number(part.sellingPrice))) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Billable catalog price must be whole VND');
        itemsToInsert.push({
          partCatalogId: part.id,
          partSource: PartSource.FIXHOME,
          partNameSnapshot: part.name,
          quantity: itemDto.quantity,
          unitPriceSnapshot: Number(part.sellingPrice),
          usageStatus: PartUsageStatus.PENDING,
          note: itemDto.note || null,
        });
      }

      // 5. Create PartRequest record
      const fulfillment = dto.fulfillmentMethod || FulfillmentMethod.PICKUP;
      const partRequest = manager.create(PartRequest, {
        serviceOrderId: orderId,
        technicianId: actor.id,
        requestType: PartRequestType.PRE_REPAIR,
        fulfillmentMethod: fulfillment,
        status: PartRequestStatus.REQUESTED,
        reason: dto.reason || 'Pre-repair spare parts planned by technician',
        shippingFee: 0,
      });

      const savedRequest = await manager.save(PartRequest, partRequest);

      // 6. Save items
      for (const item of itemsToInsert) {
        item.partRequestId = savedRequest.id;
      }
      savedRequest.items = await manager.save(
        PartRequestItem,
        itemsToInsert as PartRequestItem[],
      );

      // 7. Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_REQUEST_CREATED',
        resourceType: 'part_request',
        resourceId: savedRequest.id,
        after: {
          serviceOrderId: orderId,
          requestType: PartRequestType.PRE_REPAIR,
          fulfillmentMethod: fulfillment,
          itemCount: itemsToInsert.length,
        },
      });

      await this.warehouseFulfillment?.enroll(manager, savedRequest, actor);

      // W2 notifications are transactional and target the assigned warehouse SM / manual fallback.
      if (this.warehouseFulfillment && fulfillment === FulfillmentMethod.PICKUP) return savedRequest;
      // 8. Notify Service Managers
      try {
        const smUsers = await manager.find(User, {
          where: { role: Role.SERVICE_MANAGER, isActive: true },
        });
        for (const sm of smUsers) {
          await this.notificationsService.createNotification({
            userId: sm.id,
            title: 'Yêu cầu linh kiện mới (Trước sửa chữa)',
            message: `Kỹ thuật viên đã tạo yêu cầu linh kiện cho đơn hàng ${orderId}.`,
            type: 'PART_REQUEST_NEW',
            referenceId: savedRequest.id,
            referenceType: 'part_request',
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to send SM notifications: ${err.message}`);
      }

      return savedRequest;
    });
  }

  /** Caller holds the order lock. Legacy/tracking-only usage can only decide whole lines. */
  async assertQuotationPartQuantities(
    manager: EntityManager,
    orderId: string,
    technicianId: string,
    items: Pick<QuotationItem, 'type' | 'partSource' | 'partCatalogId' | 'quantity'>[],
  ): Promise<void> {
    const required = new Map<string, number>();
    for (const item of items) {
      if (item.type === CostItemType.PARTS_EQUIPMENT && item.partSource === PartSource.FIXHOME && item.partCatalogId) {
        required.set(item.partCatalogId, (required.get(item.partCatalogId) ?? 0) + item.quantity);
      }
    }
    if (!required.size) return;
    // A quote only tells the customer what they pay for. With return tracking on, the technician settles the real use and the
    // leftover afterwards (usedQty never exceeds the approved quote), so a quote may take fewer pieces than were issued.
    const partialQuoteAllowed = !!await custodyActivation(manager);
    const requests = await this.withoutUnsourced(manager, await manager.find(PartRequest, { where: { serviceOrderId: orderId, technicianId }, relations: ['items'] }));
    const lines = requests.filter(request => request.technicianId === technicianId && request.requestType === PartRequestType.PRE_REPAIR &&
      [PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING, PartRequestStatus.RECEIVED].includes(request.status))
      .flatMap(request => request.items).filter(item => item.partSource === PartSource.FIXHOME && item.usageStatus !== PartUsageStatus.RETURNED);
    for (const [sku, quantity] of required) {
      const quantities = lines.filter(item => item.partCatalogId === sku).map(item => item.quantity);
      // A positive deficit gets a new exact QUOTATION line. If stock covers the
      // quote, some subset of its whole lines must equal the approved quantity.
      if (quantities.reduce((sum, value) => sum + value, 0) <= quantity || partialQuoteAllowed) continue;
      let reachable = new Set([0]);
      for (const value of quantities) {
        const next = new Set(reachable);
        for (const sum of reachable) {
          if (sum + value <= quantity) next.add(sum + value);
        }
        reachable = next;
        if (reachable.has(quantity)) break;
      }
      if (!reachable.has(quantity)) {
        throw new BusinessException(ErrorCodes.CONFLICT,
          'Số lượng linh kiện FixHome trong báo giá không khớp các dòng đã yêu cầu. Vui lòng điều chỉnh số lượng để dùng hoặc trả nguyên dòng; nếu yêu cầu trước sửa chữa còn chờ chuẩn bị, hãy hủy trước khi lập lại báo giá để kho cấp đúng số lượng.');
      }
    }
  }

  /** Caller holds the order lock and has persisted the customer's APPROVED decision. */
  async createRequestFromApprovedQuotation(manager: EntityManager, quote: Quotation, actor: { id: string; role: string }): Promise<PartRequest | null> {
    if (quote.status !== QuotationStatus.APPROVED) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Báo giá chưa được duyệt.');
    if (!await manager.findOneBy(TechnicianAssignment, { serviceOrderId: quote.serviceOrderId, technicianId: quote.technicianId, isActive: true })) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Kỹ thuật viên không còn phụ trách đơn sửa chữa.');
    }
    const existing = await manager.findOne(PartRequest, { where: { quotationId: quote.id }, relations: ['items'] });
    if (existing) return existing;
    const deficit = await this.quotationDeficit(manager, quote.serviceOrderId, quote.technicianId, quote.items);
    if (!deficit.length) return null;
    for (const [partCatalogId] of deficit) {
      if (!await manager.findOne(FixHomePart, { where: { id: partCatalogId, isActive: true } })) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Linh kiện trong báo giá không còn được cấp từ kho.');
      }
    }
    const request = await manager.save(PartRequest, manager.create(PartRequest, {
      serviceOrderId: quote.serviceOrderId, technicianId: quote.technicianId, requestType: PartRequestType.QUOTATION,
      quotationId: quote.id, additionalCostId: null, fulfillmentMethod: FulfillmentMethod.PICKUP, shippingFee: 0,
      status: PartRequestStatus.REQUESTED, reason: 'Linh kiện theo báo giá đã được khách hàng duyệt',
    }));
    // Group approvals by SKU for deficit calculation, then respect the existing depot/custody line limit.
    request.items = await manager.save(PartRequestItem, deficit.flatMap(([partCatalogId, item]) =>
      Array.from({ length: Math.ceil(item.quantity / MAX_PART_QUANTITY) }, (_, index) => manager.create(PartRequestItem, {
        partRequestId: request.id, partCatalogId, partSource: PartSource.FIXHOME, partNameSnapshot: item.name,
        quantity: Math.min(MAX_PART_QUANTITY, item.quantity - index * MAX_PART_QUANTITY), unitPriceSnapshot: item.unitPrice, usageStatus: PartUsageStatus.PENDING,
      }))));
    await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role,
      action: 'QUOTATION_PART_REQUEST_CREATED', resourceType: 'part_request', resourceId: request.id,
      after: { serviceOrderId: quote.serviceOrderId, quotationId: quote.id, itemCount: request.items.length } });
    // F3 (TECH 66, CUSTOMER 72): no warehouse holds the whole shortfall, so the parts cannot be supplied.
    // Throwing rolls back the caller's approval: the quote stays SENT, totals and the request are undone.
    const placed = await this.warehouseFulfillment?.enroll(manager, request, actor);
    if (placed?.status === 'stock_unavailable') {
      throw partsSourceUnavailable(deficit.map(([partCatalogId, item]) => ({ partCatalogId, name: item.name, quantity: item.quantity })));
    }
    return request;
  }

  /**
   * FixHome parts an approval of these lines still needs from a warehouse: the quoted quantity
   * per SKU less the live pre-repair lines that have a real source (BUG DETECTOR 77).
   */
  private async quotationDeficit(manager: EntityManager, orderId: string, technicianId: string, items: SourcingLine[]) {
    const required = new Map<string, { quantity: number; name: string; unitPrice: number }>();
    for (const item of items) {
      if (item.type !== CostItemType.PARTS_EQUIPMENT || item.partSource !== PartSource.FIXHOME) continue;
      if (!item.partCatalogId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
          !Number.isSafeInteger(Number(item.unitPrice)) || Number(item.unitPrice) < 0) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Linh kiện trong báo giá không hợp lệ.');
      }
      const prior = required.get(item.partCatalogId);
      required.set(item.partCatalogId, { quantity: (prior?.quantity ?? 0) + item.quantity,
        name: prior?.name ?? item.partNameSnapshot ?? item.description, unitPrice: prior?.unitPrice ?? Number(item.unitPrice) });
    }
    if (!required.size) return [];
    const requests = await this.withoutUnsourced(manager, await manager.find(PartRequest, { where: { serviceOrderId: orderId, technicianId }, relations: ['items'] }));
    for (const request of requests) {
      if (request.technicianId !== technicianId || request.requestType !== PartRequestType.PRE_REPAIR ||
          ![PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING, PartRequestStatus.RECEIVED].includes(request.status)) continue;
      for (const item of request.items) {
        const need = item.partCatalogId && required.get(item.partCatalogId);
        if (need && item.partSource === PartSource.FIXHOME && item.usageStatus !== PartUsageStatus.RETURNED) need.quantity = Math.max(0, need.quantity - item.quantity);
      }
    }
    return [...required].filter(([, item]) => item.quantity > 0);
  }

  /**
   * F3 (TECH 66, CUSTOMER 72): read-only answer to "can these lines be approved now?".
   * none: no FixHome part; covered: parts already held cover it; available: one active
   * warehouse holds every missing SKU; unavailable: no warehouse does, with the missing lines.
   * Advisory only, two queries at most: the approval re-checks under stock locks.
   */
  async quotationSourcing(manager: EntityManager, orderId: string, technicianId: string, items: SourcingLine[]): Promise<PartsSourcing> {
    if (!items.some(item => item.type === CostItemType.PARTS_EQUIPMENT && item.partSource === PartSource.FIXHOME)) return { status: 'none', missing: [] };
    const deficit = await this.quotationDeficit(manager, orderId, technicianId, items);
    if (!deficit.length) return { status: 'covered', missing: [] };
    if (!this.warehouseFulfillment) return { status: 'available', missing: [] };
    const missing = deficit.map(([partCatalogId, item]) => ({ partCatalogId, name: item.name, quantity: item.quantity }));
    const required = missing.map(item => ({ partId: item.partCatalogId, quantity: item.quantity }));
    const stock: Array<{ warehouseId: string; partId: string; onHand: number; reserved: number }> = await manager.query(`
      SELECT s.warehouse_id AS "warehouseId", s.part_id AS "partId", s.on_hand AS "onHand", s.reserved
        FROM warehouse_stock s JOIN warehouses w ON w.id = s.warehouse_id JOIN users u ON u.id = w.responsible_user_id
       WHERE w.status = 'active' AND u.role = 'service_manager' AND u.is_active AND u.status = 'active'
         AND s.part_id = ANY($1::uuid[])`, [required.map(item => item.partId)]);
    const available = [...new Set(stock.map(row => row.warehouseId))]
      .some(id => hasWholeRequestStock(required, stock.filter(row => row.warehouseId === id)));
    return available ? { status: 'available', missing: [] } : { status: 'unavailable', missing };
  }

  /**
   * BUG DETECTOR 77: a request no FixHome warehouse could stock (W2 stock_unavailable, kept in the
   * database as manual_assistance) is not a source of parts. Counting it as one let an approved quote
   * skip the request it needed, so the parts were billed as supplied but never came.
   */
  private async withoutUnsourced(manager: EntityManager, requests: PartRequest[]): Promise<PartRequest[]> {
    const waiting = requests.filter(request => request.status === PartRequestStatus.REQUESTED).map(request => request.id);
    if (!waiting.length) return requests;
    const rows = await manager.find(WarehouseAllocation, {
      where: { partRequestId: In(waiting), status: 'manual_assistance' }, select: ['partRequestId'] });
    const unsourced = new Set(rows.map(row => row.partRequestId));
    return unsourced.size ? requests.filter(request => !unsourced.has(request.id)) : requests;
  }

  /**
   * FixHome parts the technician holds (or has on the way) for this order that no approval has
   * claimed yet (BUG DETECTOR 14): every live line not returned, less what the technician has
   * declared going back, less what the approved quotation and approved additional costs use.
   * Caller holds the order lock. The additional cost being approved is not approved yet here.
   */
  private async unclaimedFixHomeStock(manager: EntityManager, orderId: string, technicianId: string): Promise<Map<string, number>> {
    const live = [PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING, PartRequestStatus.RECEIVED];
    const stock = new Map<string, number>();
    const add = (id: string, quantity: number) => stock.set(id, (stock.get(id) ?? 0) + quantity);
    const custody = await manager.find(PartCustody, { where: { serviceOrderId: orderId, technicianId } });
    const goingBack = new Map(custody.map(row => [row.partRequestItemId, (row.state?.declarations ?? []).reduce((sum, d) => sum + d.quantity, 0)]));
    const requests = await this.withoutUnsourced(manager, await manager.find(PartRequest, { where: { serviceOrderId: orderId, technicianId }, relations: ['items'] }));
    for (const request of requests) {
      if (!live.includes(request.status)) continue;
      for (const item of request.items) {
        if (item.partSource === PartSource.FIXHOME && item.partCatalogId && item.usageStatus !== PartUsageStatus.RETURNED) {
          add(item.partCatalogId, item.quantity - (goingBack.get(item.id) ?? 0));
        }
      }
    }
    const quotes = await manager.find(Quotation, { where: { serviceOrderId: orderId, technicianId, status: QuotationStatus.APPROVED }, relations: ['items'] });
    const costs = await manager.find(AdditionalCostRequest, { where: { serviceOrderId: orderId, technicianId, status: AdditionalCostStatus.APPROVED }, relations: ['items'] });
    for (const item of [...quotes.flatMap(q => q.items), ...costs.flatMap(c => c.items)]) {
      if (item.type === CostItemType.PARTS_EQUIPMENT && item.partSource === PartSource.FIXHOME && item.partCatalogId) add(item.partCatalogId, -item.quantity);
    }
    return stock;
  }

  /** Flow 2: called when the customer approves an additional cost with FixHome parts. */
  async createAdditionalRequestFromApprovedCost(
    manager: EntityManager,
    orderId: string,
    technicianId: string,
    additionalCostId: string,
    fulfillmentMethod: FulfillmentMethod,
    shippingFee: number,
    items: Array<{
      partCatalogId?: string | null;
      partName: string;
      quantity: number;
      unitPrice: number;
      partSource: PartSource;
      note?: string | null;
    }>,
  ): Promise<PartRequest | null> {
    // Only FixHome parts generate depot parts requests
    const wanted = items.filter(
      (i) => i.partSource === PartSource.FIXHOME,
    );
    if (wanted.length === 0) return null;
    // Parts the technician already holds are used first; only the shortfall comes from the warehouse.
    // Usage and invoicing let those held units serve this cost (quotation surplus, see lifecycle).
    const unclaimed = await this.unclaimedFixHomeStock(manager, orderId, technicianId);
    const fixHomeItems = wanted.flatMap((item) => {
      const id = item.partCatalogId;
      const take = id ? Math.min(Math.max(0, unclaimed.get(id) ?? 0), item.quantity) : 0;
      if (id && take > 0) unclaimed.set(id, (unclaimed.get(id) ?? 0) - take);
      return item.quantity - take > 0 ? [{ ...item, quantity: item.quantity - take }] : [];
    });
    if (fixHomeItems.length === 0) return null;

    if (!await manager.findOneBy(TechnicianAssignment, { serviceOrderId: orderId, technicianId, isActive: true })) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Additional cost technician is no longer assigned to this order');
    }

    for (const item of fixHomeItems) {
      if (!item.partCatalogId || !await manager.findOne(FixHomePart, { where: { id: item.partCatalogId, isActive: true } })) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Approved part is no longer active in FixHome catalog');
      }
    }
    const partRequest = manager.create(PartRequest, {
      serviceOrderId: orderId,
      technicianId,
      requestType: PartRequestType.ADDITIONAL,
      fulfillmentMethod,
      shippingFee,
      additionalCostId,
      status: PartRequestStatus.REQUESTED,
      reason: 'Additional parts approved by customer',
    });

    const savedRequest = await manager.save(PartRequest, partRequest);

    const itemsToSave: Partial<PartRequestItem>[] = fixHomeItems.map((i) => ({
      partRequestId: savedRequest.id,
      partCatalogId: i.partCatalogId || null,
      partSource: PartSource.FIXHOME,
      partNameSnapshot: i.partName,
      quantity: i.quantity,
      unitPriceSnapshot: i.unitPrice,
      usageStatus: PartUsageStatus.PENDING,
      note: i.note || null,
    }));

    savedRequest.items = await manager.save(
      PartRequestItem,
      itemsToSave as PartRequestItem[],
    );

    // Only newly inserted, full-source ADDITIONAL DELIVERY requests enter W3.
    // A deficit supplied partly from historical stock stays entirely in its legacy flow.
    if (fulfillmentMethod === FulfillmentMethod.DELIVERY && isDeepStrictEqual(
      canonicalWarehouseQuantities(savedRequest.items),
      canonicalWarehouseQuantities(wanted.map(i => ({ partCatalogId: i.partCatalogId, partSource: i.partSource, quantity: i.quantity }))),
    )) {
      try {
        await new WarehouseDeliveryStore().enrollNew(manager, savedRequest.id, { id: technicianId, role: Role.TECHNICIAN });
      } catch (error) {
        // The store throws plain Errors; the customer gets a reason instead of a 500.
        if (error instanceof Error && error.message.startsWith('WAREHOUSE_DELIVERY_')) throw new BusinessException(ErrorCodes.CONFLICT, 'Chưa ghi nhận được phiếu giao linh kiện cho đơn này. Vui lòng thử lại hoặc liên hệ quản lý dịch vụ.');
        throw error;
      }
    }

    // Audit log
    await this.auditLogService.logWithManager(manager, {
      actorUserId: technicianId,
      actorRole: Role.TECHNICIAN,
      action: 'ADDITIONAL_PART_REQUEST_CREATED',
      resourceType: 'part_request',
      resourceId: savedRequest.id,
      after: {
        serviceOrderId: orderId,
        additionalCostId,
        fulfillmentMethod,
        itemCount: itemsToSave.length,
      },
    });

    // F3: same gate as a quotation. No warehouse holds the shortfall: the approval rolls back, the cost stays pending.
    const placed = await this.warehouseFulfillment?.enroll(manager, savedRequest, { id: technicianId, role: Role.TECHNICIAN });
    if (placed?.status === 'stock_unavailable') {
      throw partsSourceUnavailable(fixHomeItems.map(item => ({ partCatalogId: item.partCatalogId!, name: item.partName, quantity: item.quantity })));
    }
    return savedRequest;
  }

  /**
   * Service Manager: Mark Part Request as READY
   * Generates secure QR handover token
   */
  async markReady(
    requestId: string,
    actor: { id: string; role: string },
    dto?: MarkReadyDto,
  ): Promise<PartRequest> {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { request } = await this.lockRequest(manager, requestId, actor);

      if (request.requestType !== PartRequestType.WARRANTY && await this.warehouseFulfillment?.allocation(manager, requestId)) throw new BusinessException(ErrorCodes.CONFLICT, 'Vui lòng chuẩn bị mã nhận tại luồng kho được phân công.');

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      // W3 delivery requests move through warehouse delivery events; the old QR path is closed by a DB trigger.
      const [w3] = await manager.query('SELECT 1 FROM warehouse_delivery_cohorts WHERE part_request_id = $1 LIMIT 1', [requestId]);
      if (w3) throw new BusinessException(ErrorCodes.CONFLICT, 'Phiếu này giao linh kiện theo luồng giao hàng có phí. Vui lòng xử lý ở khối Giao linh kiện, không dùng Chuẩn bị xong.');

      // Check state machine
      if (
        !PartRequestStateMachine.canTransitionWithFulfillment(
          request.status,
          PartRequestStatus.READY,
          request.fulfillmentMethod,
          actor.role as Role,
        )
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          `Cannot transition part request from ${request.status} to ${PartRequestStatus.READY}`,
        );
      }

      // Generate cryptographically secure QR token
      const qrToken = `FH-PR-${request.id.slice(0, 8)}-${crypto.randomBytes(16).toString('hex')}`;

      request.status = PartRequestStatus.READY;
      request.qrToken = qrToken;
      request.qrGeneratedAt = new Date();
      request.preparedByUserId = actor.id;

      const saved = await manager.save(PartRequest, request);

      // Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_REQUEST_READY',
        resourceType: 'part_request',
        resourceId: requestId,
        after: {
          status: PartRequestStatus.READY,
          qrGeneratedAt: request.qrGeneratedAt,
          note: dto?.note || null,
        },
      });

      // Notify technician
      try {
        await this.notificationsService.createNotification({
          userId: request.technicianId,
          title: 'Linh kiện đã sẵn sàng!',
          message:
            request.fulfillmentMethod === FulfillmentMethod.PICKUP
              ? 'Linh kiện yêu cầu đã sẵn sàng tại kho. Vui lòng quét mã QR khi nhận hàng.'
              : 'Linh kiện đã được chuẩn bị xong và chuẩn bị chuyển giao.',
          type: 'PART_REQUEST_READY',
          referenceId: requestId,
          referenceType: 'part_request',
        });
      } catch (err) {
        this.logger.warn(`Failed to notify technician: ${err.message}`);
      }

      return saved;
    });
  }

  /**
   * Service Manager: Mark DELIVERY Part Request as DELIVERING
   */
  async markDelivering(
    requestId: string,
    actor: { id: string; role: string },
    dto?: MarkDeliveringDto,
  ): Promise<PartRequest> {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { request } = await this.lockRequest(manager, requestId, actor);

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      if (request.fulfillmentMethod !== FulfillmentMethod.DELIVERY) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'DELIVERING state only applies to DELIVERY fulfillment method',
        );
      }

      if (
        !PartRequestStateMachine.canTransitionWithFulfillment(
          request.status,
          PartRequestStatus.DELIVERING,
          request.fulfillmentMethod,
          actor.role as Role,
        )
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          `Cannot transition part request from ${request.status} to ${PartRequestStatus.DELIVERING}`,
        );
      }

      if (dto?.shippingFee !== undefined && dto.shippingFee !== Number(request.shippingFee)) {
        throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Approved shipping fee is immutable');
      }

      request.status = PartRequestStatus.DELIVERING;
      const saved = await manager.save(PartRequest, request);

      // Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_REQUEST_DELIVERING',
        resourceType: 'part_request',
        resourceId: requestId,
        after: {
          status: PartRequestStatus.DELIVERING,
          shippingFee: request.shippingFee,
          note: dto?.note || null,
        },
      });

      // Notify technician
      try {
        await this.notificationsService.createNotification({
          userId: request.technicianId,
          title: 'Linh kiện đang được giao',
          message:
            'Linh kiện đang trên đường giao tới bạn. Vui lòng quét mã QR khi nhận hàng.',
          type: 'PART_REQUEST_DELIVERING',
          referenceId: requestId,
          referenceType: 'part_request',
        });
      } catch (err) {
        this.logger.warn(`Failed to notify technician: ${err.message}`);
      }

      return saved;
    });
  }

  async regenerateQr(requestId: string, actor: { id: string; role: string }): Promise<PartRequest> {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    return this.dataSource.transaction(async manager => {
      const { request } = await this.lockRequest(manager, requestId, actor);
      if (![PartRequestStatus.READY, PartRequestStatus.DELIVERING].includes(request.status) || request.receivedAt) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'QR can only be rotated before handover');
      }
      if (request.requestType !== PartRequestType.WARRANTY && await this.warehouseFulfillment?.allocation(manager, requestId)) throw new BusinessException(ErrorCodes.CONFLICT, 'Vui lòng đổi mã tại luồng kho được phân công.');
      request.qrToken = `FH-PR-${request.id.slice(0, 8)}-${crypto.randomBytes(16).toString('hex')}`;
      request.qrGeneratedAt = new Date();
      await this.auditLogService.logWithManager(manager, { actorUserId: actor.id, actorRole: actor.role, action: 'PART_REQUEST_QR_ROTATED', resourceType: 'part_request', resourceId: requestId });
      return manager.save(PartRequest, request);
    });
  }

  /**
   * Flow 1 & 2: Technician receives parts via QR code scanning
   * Backend validates:
   * 1. Request exists
   * 2. Request belongs to this technician
   * 3. Request belongs to an active order
   * 4. Request status is READY (for PICKUP) or DELIVERING (for DELIVERY)
   * 5. QR token matches and is not expired (valid for 48h)
   * 6. Request has not already been received
   */
  async receiveByQr(
    requestId: string,
    dto: ReceivePartRequestDto,
    actor: { id: string; role: string },
  ): Promise<PartRequest> {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { request, order } = await this.lockRequest(manager, requestId, actor);

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      // Check ownership: must belong to the scanning technician
      if (request.technicianId !== actor.id) {
        throw new BusinessException(
          ErrorCodes.OWNERSHIP_DENIED,
          'This part request belongs to another technician',
        );
      }

      // Check if already received
      if (request.status === PartRequestStatus.RECEIVED || request.receivedAt) {
        throw new BusinessException(
          ErrorCodes.CONFLICT,
          'Parts have already been received for this request',
        );
      }

      // Every receipt needs the token the Service Manager issued, within 48 hours,
      // through the state machine. The TEST / TEST_SCAN / TEST_RECEIVED shortcut
      // that skipped all three was removed (PO 07/10/2026: no simulated flows).
      // Check state transition
      if (
        !PartRequestStateMachine.canTransitionWithFulfillment(
          request.status,
          PartRequestStatus.RECEIVED,
          request.fulfillmentMethod,
          Role.TECHNICIAN,
        )
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          `Cannot receive parts when request status is ${request.status}`,
        );
      }

      const warehouseAcknowledged = request.requestType !== PartRequestType.WARRANTY && await this.warehouseFulfillment?.acknowledge(manager, request, dto.qrToken.trim());
      // Legacy retains its existing QR contract; W2 uses the separate physical-handover receipt.
      if (!warehouseAcknowledged && (!request.qrToken || request.qrToken !== dto.qrToken.trim())) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Invalid QR token for this part request',
        );
      }

      // Token expiry check: 48 hours
      if (!warehouseAcknowledged && !request.qrGeneratedAt) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'QR token has no issue date');
      if (!warehouseAcknowledged && request.qrGeneratedAt) {
        const expiryMs = 48 * 60 * 60 * 1000;
        if (Date.now() - new Date(request.qrGeneratedAt).getTime() > expiryMs) {
          throw new BusinessException(
            ErrorCodes.CONFLICT,
            'QR token has expired. Please request SM to regenerate.',
          );
        }
      }

      // Mark RECEIVED
      request.status = PartRequestStatus.RECEIVED;
      request.receivedAt = new Date();
      request.qrToken = null;

      const saved = await manager.save(PartRequest, request);
      if (!warehouseAcknowledged) await this.custodyService?.enrollHandover(manager, request, order);
      // The faulty part is due back within a few days; nothing is charged until it is inspected or overdue.
      if (request.requestType === PartRequestType.WARRANTY) await this.warrantyCost()?.startReturnClock(manager, saved);

      // Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_REQUEST_RECEIVED',
        resourceType: 'part_request',
        resourceId: requestId,
        after: {
          status: PartRequestStatus.RECEIVED,
          receivedAt: request.receivedAt,
        },
      });

      // Notify SM
      try {
        if (request.preparedByUserId) {
          await this.notificationsService.createNotification({
            userId: request.preparedByUserId,
            title: 'Kỹ thuật viên đã nhận linh kiện',
            message: `Kỹ thuật viên đã quét QR và nhận thành công linh kiện cho đơn hàng ${request.serviceOrderId}.`,
            type: 'PART_REQUEST_RECEIVED',
            referenceId: requestId,
            referenceType: 'part_request',
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to notify SM: ${err.message}`);
      }

      return saved;
    });
  }

  /**
   * Flow 1: Technician marks each part item as USED or RETURNED
   * - Must belong to technician
   * - PartRequest must be in RECEIVED status
   * - Order must be in UNDER_REPAIR status
   */
  async updateItemUsage(
    requestId: string,
    itemId: string,
    dto: UpdateItemUsageDto,
    actor: { id: string; role: string },
  ): Promise<PartRequestItem> {
    if (actor.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    if (![PartUsageStatus.USED, PartUsageStatus.RETURNED].includes(dto.usageStatus)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Usage must be USED or RETURNED');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { request, order } = await this.lockRequest(manager, requestId, actor);
      const warranty = request.requestType === PartRequestType.WARRANTY;
      // A warranty request is used after the order completed, so the repair state and the quotation do not apply.
      if (!warranty && order.status !== ServiceOrderStatus.UNDER_REPAIR) throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Item usage requires UNDER_REPAIR');

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      if (request.technicianId !== actor.id) {
        throw new BusinessException(
          ErrorCodes.OWNERSHIP_DENIED,
          'Access denied to this part request',
        );
      }

      const w3Received = request.status === PartRequestStatus.REQUESTED && request.fulfillmentMethod === 'delivery'
        && (await manager.query('SELECT w3_received_request($1) AS received', [request.id]))[0]?.received === true;
      if (w3Received && (dto.usageStatus !== PartUsageStatus.USED || dto.usedQty !== undefined)) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Luồng giao linh kiện này chỉ hỗ trợ ghi nhận dùng toàn bộ sau khi nhận. Vui lòng liên hệ FixHome để trả linh kiện.');
      }
      if (request.status !== PartRequestStatus.RECEIVED && !w3Received) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          'Can only update item usage after parts have been RECEIVED',
        );
      }

      const item = await manager.findOne(PartRequestItem, {
        where: { id: itemId, partRequestId: requestId },
      });

      if (!item) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request item not found',
        );
      }

      const previous = item.usageStatus;
      if (warranty && previous !== PartUsageStatus.PENDING) {
        throw new BusinessException(ErrorCodes.CONFLICT, 'Linh kiện bảo hành đã được ghi nhận sử dụng.');
      }
      if (!warranty && item.partSource === PartSource.FIXHOME && dto.usageStatus === PartUsageStatus.USED) {
        await this.assertUsageApproved(manager, request, item, dto.usedQty ?? item.quantity);
      }
      const custodyRecorded = await this.custodyService?.recordUsage(manager, request, item, order, dto, actor);
      if (!custodyRecorded && [dto.usedQty, dto.expectedVersion, dto.idempotencyKey].some(value => value !== undefined)) {
        throw new BadRequestException('Số lượng chi tiết chỉ áp dụng cho linh kiện được bàn giao sau khi mở chức năng trả linh kiện.');
      }
      if (custodyRecorded && dto.usedQty !== undefined && dto.usageStatus !== (dto.usedQty > 0 ? PartUsageStatus.USED : PartUsageStatus.RETURNED)) throw new BadRequestException('Trạng thái sử dụng không khớp số lượng đã dùng.');
      if (custodyRecorded === 'replayed') return item;
      item.usageStatus = dto.usageStatus;
      const saved = await manager.save(PartRequestItem, item);
      if (warranty) await this.warrantyCost()?.creditReturned(manager, request, saved);

      // Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_ITEM_USAGE_UPDATED',
        resourceType: 'part_request_item',
        resourceId: itemId,
        before: { usageStatus: previous },
        after: { usageStatus: dto.usageStatus },
      });

      return saved;
    });
  }

  /**
   * The order lock serializes USED changes across all requests sharing an approval.
   *
   * Each approval keeps its own quantity: an additional cost's request is used within that
   * cost. Units delivered for the quotation may be used beyond the quotation for an approved
   * additional cost that its own request does not cover (BUG DETECTOR 14): the technician
   * already holds them, so the additional cost does not need new ones from the warehouse.
   */
  private async assertUsageApproved(manager: EntityManager, request: PartRequest, item: PartRequestItem, usedQty: number): Promise<void> {
    if (request.requestType === PartRequestType.ADDITIONAL && !request.additionalCostId) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Yêu cầu linh kiện chưa liên kết chi phí đã duyệt.');
    }
    const quote = await manager.findOne(Quotation, { where: { serviceOrderId: request.serviceOrderId, technicianId: request.technicianId, status: QuotationStatus.APPROVED }, relations: ['items'] });
    const costs = await manager.find(AdditionalCostRequest, { where: { serviceOrderId: request.serviceOrderId, technicianId: request.technicianId, status: AdditionalCostStatus.APPROVED }, relations: ['items'] });
    const ownCostApproved = request.requestType !== PartRequestType.ADDITIONAL || costs.some(cost => cost.id === request.additionalCostId);
    const source = partRequestCostSource(request, quote?.id);
    if ((!quote && !costs.length) || !ownCostApproved || !source || !item.partCatalogId || !Number.isSafeInteger(usedQty) || usedQty < 1 || usedQty > item.quantity) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chỉ được dùng linh kiện đúng báo giá đã duyệt.');
    }
    const forPart = (lines: Array<{ partSource?: PartSource | null; partCatalogId?: string | null; quantity: number }> | undefined) =>
      (lines ?? []).filter(i => i.partSource === PartSource.FIXHOME && i.partCatalogId === item.partCatalogId).reduce((sum, i) => sum + i.quantity, 0);
    const approved = new Map<string, number>([['quotation', forPart(quote?.items)], ...costs.map(cost => [cost.id, forPart(cost.items)] as [string, number])]);
    const requests = await manager.find(PartRequest, { where: { serviceOrderId: request.serviceOrderId, technicianId: request.technicianId }, relations: ['items'] });
    const custodyUsage = await custodyUsageForInvoice(manager, request.serviceOrderId);
    const used = new Map<string, number>([[source, usedQty]]);
    for (const other of requests) {
      const otherSource = partRequestCostSource(other, quote?.id);
      if (other.technicianId !== request.technicianId || ![PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED].includes(other.status) || !otherSource) continue;
      for (const line of other.items) {
        if (line.id !== item.id && line.partSource === PartSource.FIXHOME && line.partCatalogId === item.partCatalogId && line.usageStatus === PartUsageStatus.USED) {
          used.set(otherSource, (used.get(otherSource) ?? 0) + (custodyUsage.get(line.id) ?? line.quantity));
        }
      }
    }
    const unsuppliedCosts = [...approved].filter(([key]) => key !== 'quotation')
      .reduce((sum, [key, quantity]) => sum + Math.max(0, quantity - (used.get(key) ?? 0)), 0);
    const allowance = (approved.get(source) ?? 0) + (source === 'quotation' ? unsuppliedCosts : 0);
    // Base supply may already consume an additional approval's allowance. Check the
    // SKU total too, so updating the additional request cannot consume it again.
    const totalUsed = [...used.values()].reduce((sum, quantity) => sum + quantity, 0);
    const totalApproved = [...approved.values()].reduce((sum, quantity) => sum + quantity, 0);
    if ((used.get(source) ?? 0) > allowance || totalUsed > totalApproved) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Số lượng sử dụng vượt báo giá đã duyệt. Vui lòng đề xuất chi phí phát sinh.');
  }

  /**
   * Cancel a Part Request
   * SM can cancel unreceived requests
   * Technician can only cancel if still REQUESTED
   */
  async cancelPartRequest(
    requestId: string,
    actor: { id: string; role: string },
    reason?: string,
  ): Promise<PartRequest> {
    if (![Role.SERVICE_MANAGER, Role.TECHNICIAN].includes(actor.role as Role)) throw new ForbiddenException('Operation not permitted');
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { request } = await this.lockRequest(manager, requestId, actor);

      const allocation = request.requestType !== PartRequestType.WARRANTY ? await this.warehouseFulfillment?.allocation(manager, requestId) : null;
      if (allocation) {
        if (actor.role === Role.SERVICE_MANAGER && allocation.warehouseId) await this.warehouseFulfillment!.requireManager(manager, allocation, actor, false);
        if (['handed_over','received'].includes(allocation.status)) throw new BusinessException(ErrorCodes.CONFLICT, 'Linh kiện đã xuất vật lý; không thể tự đảo tồn kho bằng hủy yêu cầu.');
      }

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      // Role check
      if (actor.role === Role.TECHNICIAN) {
        if (request.technicianId !== actor.id) {
          throw new BusinessException(
            ErrorCodes.OWNERSHIP_DENIED,
            'Access denied',
          );
        }
        if (request.status !== PartRequestStatus.REQUESTED) {
          throw new BusinessException(
            ErrorCodes.ORDER_INVALID_TRANSITION,
            'Technicians can only cancel requests that are still in REQUESTED status',
          );
        }
      }

      if (
        !PartRequestStateMachine.canTransition(request.status, PartRequestStatus.CANCELLED, actor.role as Role) ||
        request.status === PartRequestStatus.RECEIVED
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          `Cannot cancel request in ${request.status} status`,
        );
      }

      // F3: a request no warehouse could stock supplies nothing; the technician may always drop it.
      if ([PartRequestType.QUOTATION, PartRequestType.PRE_REPAIR].includes(request.requestType) &&
        !(request.requestType === PartRequestType.PRE_REPAIR && allocation?.status === 'manual_assistance')) {
        const quote = await manager.findOne(Quotation, {
          where: { serviceOrderId: request.serviceOrderId, technicianId: request.technicianId, status: QuotationStatus.APPROVED,
            ...(request.requestType === PartRequestType.QUOTATION ? { id: request.quotationId! } : {}) },
          relations: ['items'],
        });
        if (quote && (request.requestType === PartRequestType.QUOTATION || request.items.some(item =>
          item.partSource === PartSource.FIXHOME && item.usageStatus !== PartUsageStatus.RETURNED && quote.items.some(line =>
            line.type === CostItemType.PARTS_EQUIPMENT && line.partSource === PartSource.FIXHOME && line.partCatalogId === item.partCatalogId && line.quantity > 0)))) {
          throw new BusinessException(ErrorCodes.CONFLICT,
            'Không thể hủy yêu cầu linh kiện đang cấp cho báo giá đã duyệt. Vui lòng tiếp tục nhận linh kiện; nếu cần hủy đơn sửa chữa, hãy liên hệ quản lý dịch vụ.');
        }
      }

      const previous = request.status;
      await this.warehouseFulfillment?.release(manager, request, actor);
      request.status = PartRequestStatus.CANCELLED;
      request.cancelledAt = new Date();
      request.qrToken = null;

      const saved = await manager.save(PartRequest, request);

      // Audit log
      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_REQUEST_CANCELLED',
        resourceType: 'part_request',
        resourceId: requestId,
        before: { status: previous },
        after: { status: PartRequestStatus.CANCELLED, reason },
      });

      return saved;
    });
  }

  /**
   * Get all part requests for a specific Service Order
   */
  async getByOrderId(
    orderId: string,
    actor: { id: string; role: string },
  ): Promise<PartRequest[]> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      await authorizeOrder(manager, orderId, actor, 'read');

      const requests = await manager.find(PartRequest, {
        where: { serviceOrderId: orderId, ...(actor.role === Role.TECHNICIAN ? { technicianId: actor.id } : {}) },
        relations: ['items'],
        order: { createdAt: 'DESC' },
      });
      return requests.map(request => this.visible(request, actor));
    });
  }

  /**
   * Get detail of a specific Part Request
   */
  async getById(
    requestId: string,
    actor: { id: string; role: string },
  ): Promise<PartRequest> {
    const request = await this.partRequestRepo.findOne({
      where: { id: requestId },
      relations: ['items'],
    });

    if (!request) {
      throw new BusinessException(
        ErrorCodes.NOT_FOUND,
        'Part request not found',
      );
    }

    // Role validation
    await authorizeOrder(this.dataSource.manager, request.serviceOrderId, actor);
    if (
      actor.role === Role.TECHNICIAN &&
      request.technicianId !== actor.id
    ) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Access denied');
    }

    return this.visible(request, actor);
  }

  /**
   * W2: list work assigned to a Service Manager's current warehouses
   */
  /** Read-only W2 queue for a manager's currently assigned warehouses. */
  async findWarehouseTasks(query: QueryPartRequestsDto, actor: { id: string; role: string }) {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException('Service Manager role required');
    return this.withWarehouseAllocations(await this.findAll(query, actor, true));
  }

  /**
   * The staff list (GET /part-requests): an Admin's rows carry their W2 allocation like the manager's
   * queue does, read for the whole page at once instead of one request per row from the page.
   */
  async findForList(query: QueryPartRequestsDto, actor: { id: string; role: string }) {
    const result = await this.findAll(query, actor);
    return actor.role === Role.ADMIN ? this.withWarehouseAllocations(result) : result;
  }

  // BUG DETECTOR 90: each row carries its W2 allocation, read for the whole page at once.
  private async withWarehouseAllocations<T extends { data: PartRequest[] }>(result: T): Promise<T> {
    if (!this.warehouseFulfillment || !result.data.length) return result;
    const allocations = await this.warehouseFulfillment.views(this.dataSource.manager, result.data.map(row => row.id));
    return { ...result, data: result.data.map(row => Object.assign(row, { warehouseAllocation: allocations.get(row.id) ?? null })) };
  }

  /** Shared paginated query; existing global staff listing remains unchanged unless explicitly scoped. */
  async findAll(
    query: QueryPartRequestsDto,
    actor: { id: string; role: string },
    warehouseTasksOnly = false,
  ): Promise<{ data: PartRequest[]; total: number; statusCounts: Record<string, number> }> {
    if (![Role.SERVICE_MANAGER, Role.ADMIN, Role.TECHNICIAN].includes(actor.role as Role)) throw new ForbiddenException('Operation not permitted');
    if (query.createdFrom && query.createdTo && new Date(query.createdFrom) > new Date(query.createdTo)) throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Invalid date range');
    const page = query.page || 1;
    const pageSize = query.pageSize || 20;

    const qb = this.partRequestRepo
      .createQueryBuilder('pr')
      .leftJoinAndSelect('pr.items', 'pri')
      .orderBy('pr.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (warehouseTasksOnly) {
      // Scope counts and rows in SQL, never in the browser; use CURRENT warehouse owner
      // so legitimately reassigned warehouses can reissue a new QR binding.
      // BUG DETECTOR 75: the queue was W2 pickups only, so delivery, warranty and older
      // requests (no W2 allocation, still every manager's work as in the global list)
      // vanished. A stock-unavailable W2 request stays out: the technician sources it.
      qb.andWhere(`(
          (pr.fulfillmentMethod = :warehousePickup AND EXISTS (
            SELECT 1 FROM part_request_warehouse_allocations w2a
            JOIN warehouses w2w ON w2w.id = w2a.warehouse_id
            WHERE w2a.part_request_id = pr.id AND w2w.responsible_user_id = :warehouseSmId))
          OR NOT EXISTS (SELECT 1 FROM part_request_warehouse_allocations w2x WHERE w2x.part_request_id = pr.id)
        )`, { warehouseSmId: actor.id, warehousePickup: FulfillmentMethod.PICKUP });
    }

    if (query.requestType) qb.andWhere('pr.requestType = :requestType', { requestType: query.requestType });
    if (query.fulfillmentMethod) qb.andWhere('pr.fulfillmentMethod = :fulfillmentMethod', { fulfillmentMethod: query.fulfillmentMethod });
    if (query.createdFrom) qb.andWhere('pr.createdAt >= :createdFrom', { createdFrom: query.createdFrom });
    if (query.createdTo) qb.andWhere('pr.createdAt <= :createdTo', { createdTo: query.createdTo });
    // BUG DETECTOR 82: the screen shows "PR-6C523040" (start of the id); a pasted code must match.
    const search = query.search?.trim().replace(/^PR-/i, '');
    if (search) qb.andWhere('(CAST(pr.id AS text) ILIKE :search OR CAST(pr.serviceOrderId AS text) ILIKE :search OR CAST(pr.technicianId AS text) ILIKE :search OR EXISTS (SELECT 1 FROM part_request_items item WHERE item.part_request_id = pr.id AND item.part_name_snapshot ILIKE :search))', { search: `%${search}%` });

    if (query.serviceOrderId) {
      qb.andWhere('pr.serviceOrderId = :orderId', {
        orderId: query.serviceOrderId,
      });
    }

    if (query.technicianId) {
      qb.andWhere('pr.technicianId = :techId', {
        techId: query.technicianId,
      });
    }

    // If technician, force filter to their own
    if (actor.role === Role.TECHNICIAN) {
      qb.andWhere('pr.technicianId = :selfId', { selfId: actor.id });
      qb.andWhere('EXISTS (SELECT 1 FROM technician_assignments a WHERE a.service_order_id = pr.service_order_id AND a.technician_id = :selfId AND a.is_active = true)');
    }

    // BUG DETECTOR 89: the status tiles counted only the 20 rows on screen. Count every
    // status over the same filters (all but the status itself), in SQL. One extra query, only
    // for the staff list that shows the tiles; the technician's lists have none (free tier, PO 11/11).
    const counting = actor.role === Role.TECHNICIAN ? null : qb.clone().orderBy().skip(undefined).take(undefined)
      .select('pr.status', 'status').addSelect('COUNT(DISTINCT pr.id)', 'n').groupBy('pr.status');
    if (query.status) qb.andWhere('pr.status = :status', { status: query.status });

    const [[data, total], counted] = await Promise.all([qb.getManyAndCount(), counting ? counting.getRawMany() : Promise.resolve([])]);
    const statusCounts: Record<string, number> = {};
    for (const row of counted as Array<{ status: string; n: string | number }>) statusCounts[row.status] = Number(row.n);
    await this.attachW3Delivery(data);
    return { data: data.map(request => this.visible(request, actor)), total, statusCounts };
  }

  /**
   * W-16: a request enrolled in W3 keeps part_requests.status = 'requested' (the legacy guard
   * forbids the old QR path), so the list carries the W3 stage: ENROLLED before any physical
   * step, else the latest event status (RESERVED, ISSUED_TO_COURIER, DISPATCH_RECORDED,
   * TECHNICIAN_RECEIVED...). One query for the whole page, only when it has delivery rows.
   */
  private async attachW3Delivery(requests: PartRequest[]): Promise<void> {
    const ids = requests.filter(r => r.fulfillmentMethod === FulfillmentMethod.DELIVERY).map(r => r.id);
    if (!ids.length) return;
    const rows: Array<{ id: string; status: string | null }> = await this.dataSource.query(
      `SELECT c.part_request_id AS id, e.snapshot->>'status' AS status
       FROM warehouse_delivery_cohorts c
       LEFT JOIN LATERAL (SELECT snapshot FROM warehouse_delivery_events we
         WHERE we.part_request_id = c.part_request_id ORDER BY we.result_version DESC LIMIT 1) e ON true
       WHERE c.part_request_id = ANY($1::uuid[])`,
      [ids],
    );
    const stage = new Map(rows.map(row => [row.id, row.status ?? 'ENROLLED']));
    for (const request of requests) (request as PartRequest & { w3DeliveryStage?: string | null }).w3DeliveryStage = stage.get(request.id) ?? null;
  }

  /**
   * Cascade cancel any active part requests when a service order is cancelled
   */
  async cancelActiveForOrder(
    manager: EntityManager,
    orderId: string,
    reason: string,
    actor: { id: string; role: string },
  ): Promise<void> {
    await releaseWarehouseReservations(manager, { serviceOrderId: orderId });
    const activeRequests = await manager.find(PartRequest, {
      where: {
        serviceOrderId: orderId,
      },
    });

    for (const pr of activeRequests) {
      if (pr.requestType === PartRequestType.WARRANTY) continue;
      if (
        pr.status !== PartRequestStatus.COMPLETED &&
        pr.status !== PartRequestStatus.CANCELLED
      ) {
        pr.status = PartRequestStatus.CANCELLED;
        pr.cancelledAt = new Date();
        pr.qrToken = null;
        await manager.save(PartRequest, pr);

        await this.auditLogService.logWithManager(manager, {
          actorUserId: actor.id,
          actorRole: actor.role,
          action: 'PART_REQUEST_CASCADE_CANCELLED',
          resourceType: 'part_request',
          resourceId: pr.id,
          after: { reason, orderId },
        });
      }
    }
  }

  /**
   * Auto-complete received part requests when the service order completes
   */
  async completeForOrder(
    manager: EntityManager,
    orderId: string,
  ): Promise<void> {
    const receivedRequests = await manager.find(PartRequest, {
      where: {
        serviceOrderId: orderId,
        status: PartRequestStatus.RECEIVED,
      },
    });

    for (const pr of receivedRequests) {
      if (pr.requestType === PartRequestType.WARRANTY) continue;
      pr.status = PartRequestStatus.COMPLETED;
      pr.completedAt = new Date();
      await manager.save(PartRequest, pr);
    }
  }
}

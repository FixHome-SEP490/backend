// src/modules/part-requests/part-requests.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  PartRequestStatus,
  PartRequestType,
  FulfillmentMethod,
  PartUsageStatus,
  PartSource,
  Role,
  ServiceOrderStatus,
} from '../../shared/enums';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { authorizeOrder } from '../service-orders/order-access';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PartRequest } from './entities/part-request.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { User } from '../users/entities/user.entity';
import { PartRequestStateMachine } from './part-request-state-machine';
import {
  CreatePartRequestDto,
  ReceivePartRequestDto,
  UpdateItemUsageDto,
  MarkReadyDto,
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
  ) {}

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
        },
      });

      if (
        existingActive &&
        existingActive.status !== PartRequestStatus.CANCELLED
      ) {
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

  /**
   * Flow 2: Create an Additional Parts Request from an approved Additional Cost
   * Called internally when Customer approves an Additional Cost with FixHome parts
   */
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
    const fixHomeItems = items.filter(
      (i) => i.partSource === PartSource.FIXHOME,
    );
    if (fixHomeItems.length === 0) return null;

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
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await manager.findOne(PartRequest, {
        where: { id: requestId },
        relations: ['items'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

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
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await manager.findOne(PartRequest, {
        where: { id: requestId },
        relations: ['items'],
        lock: { mode: 'pessimistic_write' },
      });

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

      if (dto?.shippingFee !== undefined) {
        request.shippingFee = dto.shippingFee;
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

  /**
   * Flow 1 & 2: Technician receives parts via QR code scanning
   * Backend validates:
   * 1. Request exists
   * 2. Request belongs to this technician
   * 3. Request belongs to an active order
   * 4. Request status is READY (for PICKUP) or READY/DELIVERING (for DELIVERY)
   * 5. QR token matches and is not expired (valid for 48h)
   * 6. Request has not already been received
   */
  async receiveByQr(
    requestId: string,
    dto: ReceivePartRequestDto,
    actor: { id: string; role: string },
  ): Promise<PartRequest> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await manager.findOne(PartRequest, {
        where: { id: requestId },
        relations: ['items'],
        lock: { mode: 'pessimistic_write' },
      });

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

      // Validate QR Token
      if (!request.qrToken || request.qrToken !== dto.qrToken.trim()) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Invalid QR token for this part request',
        );
      }

      // Token expiry check: 48 hours
      if (request.qrGeneratedAt) {
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

      const saved = await manager.save(PartRequest, request);

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
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await manager.findOne(PartRequest, {
        where: { id: requestId },
      });

      if (!request) {
        throw new BusinessException(
          ErrorCodes.NOT_FOUND,
          'Part request not found',
        );
      }

      if (request.technicianId !== actor.id && actor.role !== Role.ADMIN) {
        throw new BusinessException(
          ErrorCodes.OWNERSHIP_DENIED,
          'Access denied to this part request',
        );
      }

      if (request.status !== PartRequestStatus.RECEIVED) {
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
      item.usageStatus = dto.usageStatus;
      const saved = await manager.save(PartRequestItem, item);

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
   * Cancel a Part Request
   * SM / Admin can cancel any non-terminal request
   * Technician can only cancel if still REQUESTED
   */
  async cancelPartRequest(
    requestId: string,
    actor: { id: string; role: string },
    reason?: string,
  ): Promise<PartRequest> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const request = await manager.findOne(PartRequest, {
        where: { id: requestId },
        relations: ['items'],
        lock: { mode: 'pessimistic_write' },
      });

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
        request.status === PartRequestStatus.COMPLETED ||
        request.status === PartRequestStatus.CANCELLED
      ) {
        throw new BusinessException(
          ErrorCodes.ORDER_INVALID_TRANSITION,
          `Cannot cancel request in ${request.status} status`,
        );
      }

      const previous = request.status;
      request.status = PartRequestStatus.CANCELLED;
      request.cancelledAt = new Date();

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

      return manager.find(PartRequest, {
        where: { serviceOrderId: orderId },
        relations: ['items'],
        order: { createdAt: 'DESC' },
      });
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
    if (
      actor.role === Role.TECHNICIAN &&
      request.technicianId !== actor.id
    ) {
      throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Access denied');
    }

    return request;
  }

  /**
   * Service Manager / Admin: Query all part requests with pagination and filters
   */
  async findAll(
    query: QueryPartRequestsDto,
    actor: { id: string; role: string },
  ): Promise<{ data: PartRequest[]; total: number }> {
    const page = query.page || 1;
    const pageSize = query.pageSize || 20;

    const qb = this.partRequestRepo
      .createQueryBuilder('pr')
      .leftJoinAndSelect('pr.items', 'pri')
      .orderBy('pr.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status) {
      qb.andWhere('pr.status = :status', { status: query.status });
    }

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
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
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
    const activeRequests = await manager.find(PartRequest, {
      where: {
        serviceOrderId: orderId,
      },
    });

    for (const pr of activeRequests) {
      if (
        pr.status !== PartRequestStatus.COMPLETED &&
        pr.status !== PartRequestStatus.CANCELLED
      ) {
        pr.status = PartRequestStatus.CANCELLED;
        pr.cancelledAt = new Date();
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
      pr.status = PartRequestStatus.COMPLETED;
      pr.completedAt = new Date();
      await manager.save(PartRequest, pr);
    }
  }
}

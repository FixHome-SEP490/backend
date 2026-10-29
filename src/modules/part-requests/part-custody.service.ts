import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AccountStatus, PartRequestStatus, PartRequestType, PartSource, PartUsageStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { MAX_PAGE_SIZE } from '../../shared/constants';
import { Notification } from '../notifications/entities/notification.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { PartCustody, PartCustodyEntry } from './entities/part-custody.entity';
import { PartRequest } from './entities/part-request.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { applyCustodyCommand, createPartCustodySnapshot, PartCustodyRuleError } from './part-custody.rules';
import { LegacyManualReviewRecord, PartCustodyActor, PartCustodyCommand } from './part-custody.types';
import { custodyActivation, custodyTrackingEnabled, lockCustodyTechnician, partReturnsTrackingEnabled } from './part-custody.policy';
import { PartReturnDiscrepancyDto, PartReturnDto } from './dto/part-return.dto';

type Usage = { usedQty?: number; expectedVersion?: number; idempotencyKey?: string; usageStatus?: PartUsageStatus };

type LegacyManualReviewQueryRow = {
  partRequestItemId: string;
  partRequestId: string;
  partCatalogId: string | null;
  partNameSnapshot: string;
  issuedQty: number | string;
  orderId: string;
  technicianId: string;
  requestType: PartRequestType;
  requestStatus: PartRequestStatus;
  handedOverAt: Date | string;
};

@Injectable()
export class PartCustodyService {
  constructor(private readonly dataSource: DataSource) {}

  /** Called ONLY by successful QR receive, in the same transaction as receivedAt. */
  async enrollHandover(manager: EntityManager, request: PartRequest, order: ServiceOrder): Promise<void> {
    const activation = await custodyActivation(manager);
    if (!activation || !request.receivedAt || request.receivedAt <= activation.activatedAt! ||
        [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status) ||
        order.completionRequestedAt || await manager.findOne(Invoice, { where: { serviceOrderId: order.id } })) return;
    // Existing work stays legacy, even if its first physical handover happens after cutover.
    const trackingOnly = partReturnsTrackingEnabled();
    if (trackingOnly && (!(order.createdAt instanceof Date) || !Number.isFinite(order.createdAt.getTime()) || order.createdAt <= activation.activatedAt!)) return;
    await lockCustodyTechnician(manager, request.technicianId);
    for (const item of request.items) {
      if (item.partSource !== PartSource.FIXHOME) continue;
      const row = manager.create(PartCustody, {
        trackingOnly,
        serviceOrderId: order.id, partRequestId: request.id, partRequestItemId: item.id,
        technicianId: request.technicianId, partNameSnapshot: item.partNameSnapshot,
        cohortActivatedAt: activation.activatedAt!, handedOverAt: request.receivedAt,
        state: createPartCustodySnapshot({
          serviceOrderId: order.id, partRequestId: request.id, partRequestItemId: item.id,
          requestType: request.requestType, additionalCostId: request.additionalCostId ?? null,
          ...(request.quotationId ? { quotationId: request.quotationId } : {}),
          partCatalogId: item.partCatalogId ?? null, source: item.partSource,
          originalCustodianTechnicianId: request.technicianId, issuedQty: item.quantity,
          usedQty: 0, serviceOrderStatus: order.status, invoiceFrozen: false,
        }),
      });
      await manager.save(PartCustody, row);
    }
  }

  private async requireActive(manager: EntityManager): Promise<void> {
    // The DB switch stops NEW handovers, never reads/receipts of persisted debt.
    if (partReturnsTrackingEnabled()) return;
    if (!await custodyActivation(manager)) throw new ServiceUnavailableException('Chức năng trả linh kiện chưa được mở.');
  }

  private view(row: PartCustody): Record<string, unknown> {
    const s = row.state;
    const declaredQty = s.declarations.reduce((sum, d) => sum + d.quantity, 0);
    const discrepancies = s.events.filter(event => event.type === 'DISCREPANCY');
    return {
      id: row.id, orderId: row.serviceOrderId, partRequestId: row.partRequestId,
      partRequestItemId: row.partRequestItemId, technicianId: row.technicianId, partNameSnapshot: row.partNameSnapshot,
      issuedQty: s.issuedQty, usedQty: s.usedQty, declaredQty, managerAcceptedQty: s.managerAcceptedQty,
      outstandingQty: s.outstandingQty, version: s.version,
      trackingOnly: row.trackingOnly, blocksNewWork: row.trackingOnly && s.outstandingQty > 0,
      usageRecorded: s.events.some(event => event.type === 'USAGE_RECORDED'),
      discrepancies: discrepancies.map(event => ({ declaredQty: event.declaredQty, observedQty: event.observedQty, occurredAt: event.occurredAt })),
      returnStatus: s.returnDueQty === 0 ? 'not_required' : s.outstandingQty === 0 ? 'received' : discrepancies.length ? 'exception' : s.managerAcceptedQty > 0 ? 'partially_received'
        : declaredQty > 0 ? 'declared' : 'outstanding',
      cohortActivatedAt: new Date(row.cohortActivatedAt).toISOString(), handedOverAt: new Date(row.handedOverAt).toISOString(),
      receipts: s.receipts.map(r => ({ quantity: r.quantity, actorUserId: r.actorUserId, acceptedAt: r.acceptedAt })),
    };
  }

  async byOrder(orderId: string, actor: PartCustodyActor): Promise<Record<string, unknown>[]> {
    if (![Role.TECHNICIAN, Role.SERVICE_MANAGER].includes(actor.role as Role)) throw new ForbiddenException();
    const manager = this.dataSource.manager;
    await this.requireActive(manager);
    const rows = await manager.find(PartCustody, { where: { serviceOrderId: orderId }, order: { handedOverAt: 'ASC', id: 'ASC' } });
    if (actor.role === Role.SERVICE_MANAGER) return rows.map(row => this.view(row));
    const owned = rows.filter(row => row.technicianId === actor.id);
    if (rows.length && !owned.length) throw new ForbiddenException('Bạn không có quyền xem nội dung này.');
    if (!rows.length && !await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: orderId, technicianId: actor.id, isActive: true } })) throw new ForbiddenException();
    return owned.map(row => this.view(row));
  }

  async pending(actor: PartCustodyActor): Promise<Record<string, unknown>[]> {
    if (![Role.SERVICE_MANAGER, Role.TECHNICIAN].includes(actor.role as Role)) throw new ForbiddenException();
    await this.requireActive(this.dataSource.manager);
    const query = this.dataSource.manager.createQueryBuilder(PartCustody, 'c')
      .where("(c.state->>'outstandingQty')::int > 0");
    if (actor.role === Role.TECHNICIAN) query.andWhere('c.technicianId = :technicianId', { technicianId: actor.id });
    // Returns declared and not yet received come first (BUG DETECTOR 10), so the cap never hides
    // what the manager has to receive behind parts still held and not declared.
    const rows = await query
      .orderBy("(SELECT COALESCE(SUM((d->>'quantity')::int), 0) FROM jsonb_array_elements(COALESCE(c.state->'declarations', '[]'::jsonb)) d) > (c.state->>'managerAcceptedQty')::int", 'DESC')
      .addOrderBy('c.handedOverAt', 'ASC').addOrderBy('c.id', 'ASC').take(100).getMany();
    return rows.map(row => this.view(row));
  }

  /**
   * SM-only, read-only review of FixHome parts received before custody
   * enrollment. The item join is exact and the anti-join is the same primary
   * key used by the custody ledger. Legacy records have no physical return
   * ledger, so quantities stay unknown instead of being guessed from usage,
   * request status or an empty custody queue. No order, request or ledger row
   * is written.
   */
  async legacyManualReview(
    actor: PartCustodyActor,
    page = 1,
    pageSize = 20,
  ): Promise<{ data: LegacyManualReviewRecord[]; total: number; page: number; pageSize: number }> {
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException();
    const manager = this.dataSource.manager;
    // The custody schema is only guaranteed when the feature is active.
    await this.requireActive(manager);
    const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const safePageSize = Number.isSafeInteger(Number(pageSize)) && Number(pageSize) > 0
      ? Math.min(MAX_PAGE_SIZE, Number(pageSize))
      : 20;
    const qb = manager.createQueryBuilder(PartRequestItem, 'i')
      .innerJoin(PartRequest, 'r', 'r.id = i.part_request_id')
      .where('NOT EXISTS (SELECT 1 FROM part_custodies c WHERE c.part_request_item_id = i.id)')
      .andWhere('i.part_source = :partSource', { partSource: PartSource.FIXHOME })
      .andWhere('r.received_at IS NOT NULL')
      // RECEIVED carries the handover; COMPLETED and CANCELLED only qualify
      // when a durable received_at remains, never as proof of warehouse return.
      .andWhere('r.status IN (:...statuses)', {
        statuses: [PartRequestStatus.RECEIVED, PartRequestStatus.COMPLETED, PartRequestStatus.CANCELLED],
      });
    const total = await qb.getCount();
    const rows = await qb
      .select([
        'i.id AS "partRequestItemId"',
        'i.part_request_id AS "partRequestId"',
        'i.part_catalog_id AS "partCatalogId"',
        'i.part_name_snapshot AS "partNameSnapshot"',
        'i.quantity AS "issuedQty"',
        'r.service_order_id AS "orderId"',
        'r.technician_id AS "technicianId"',
        'r.request_type AS "requestType"',
        'r.status AS "requestStatus"',
        'r.received_at AS "handedOverAt"',
      ])
      .orderBy('r.received_at', 'ASC')
      .addOrderBy('i.id', 'ASC')
      .offset((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .getRawMany<LegacyManualReviewQueryRow>();
    return {
      data: rows.map(row => ({
        kind: 'legacy_manual_review' as const,
        receiptState: 'UNKNOWN' as const,
        orderId: row.orderId,
        partRequestId: row.partRequestId,
        partRequestItemId: row.partRequestItemId,
        technicianId: row.technicianId,
        requestType: row.requestType,
        requestStatus: row.requestStatus,
        handedOverAt: new Date(row.handedOverAt).toISOString(),
        partCatalogId: row.partCatalogId ?? null,
        partNameSnapshot: row.partNameSnapshot,
        issuedQty: Number(row.issuedQty),
      })),
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  async command(requestId: string, itemId: string, kind: 'declare_return' | 'accept_return' | 'report_discrepancy', body: PartReturnDto | PartReturnDiscrepancyDto, actor: PartCustodyActor): Promise<Record<string, unknown>> {
    if (actor.role !== (kind === 'declare_return' ? Role.TECHNICIAN : Role.SERVICE_MANAGER)) throw new ForbiddenException();
    return this.dataSource.transaction(async manager => {
      await this.requireActive(manager);
      const reference = await manager.findOne(PartCustody, { where: { partRequestItemId: itemId, partRequestId: requestId } });
      if (!reference || reference.partRequestId !== requestId) throw new NotFoundException('Không tìm thấy linh kiện cần trả.');
      if (kind === 'declare_return' && reference.technicianId !== actor.id) throw new ForbiddenException();
      const order = await manager.findOne(ServiceOrder, { where: { id: reference.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new NotFoundException();
      await lockCustodyTechnician(manager, reference.technicianId);
      const ids = { partRequestId: requestId, partRequestItemId: itemId };
      const command: PartCustodyCommand = kind === 'report_discrepancy'
        ? { ...body as PartReturnDiscrepancyDto, ...ids, kind }
        : { ...body as PartReturnDto, ...ids, kind };
      const result = await this.execute(manager, itemId, command, actor, order);
      if (command.kind === 'declare_return' && !result.replayed) {
        // Return routes authorize Service Managers globally, without an assigned manager/area.
        const recipients = await manager.find(User, {
          where: { role: Role.SERVICE_MANAGER, isActive: true, status: AccountStatus.ACTIVE },
          select: { id: true },
        });
        // Commit notices with the ledger/idempotency entry. The existing DB trigger publishes
        // notification:new only after commit; an insert failure must roll back the declaration.
        if (recipients.length) await manager.insert(Notification, recipients.map(recipient => ({
          userId: recipient.id,
          title: 'Linh kiện chờ nhận hoàn trả',
          message: `Kỹ thuật viên đã khai trả ${command.quantity} linh kiện của yêu cầu ${requestId}. Vui lòng kiểm tra và xác nhận số lượng thực nhận.`,
          type: 'PART_RETURN_DECLARED',
          referenceId: requestId,
          referenceType: 'PART_REQUEST',
          isRead: false,
        })));
      }
      return result.response;
    });
  }

  /** Existing usage route, with explicit quantities ONLY for enrolled items. Caller holds Order lock. */
  async recordUsage(manager: EntityManager, request: PartRequest, item: PartRequestItem, order: ServiceOrder, body: Usage, actor: PartCustodyActor): Promise<boolean | 'replayed'> {
    if (!custodyTrackingEnabled()) return false;
    const row = await manager.findOne(PartCustody, { where: { partRequestItemId: item.id } });
    if (!row) return false;
    if (actor.role !== Role.TECHNICIAN || row.technicianId !== actor.id || row.partRequestId !== request.id) throw new ForbiddenException();
    if (row.trackingOnly && [body.usedQty, body.expectedVersion, body.idempotencyKey].every(value => value === undefined)
        && [PartUsageStatus.USED, PartUsageStatus.RETURNED].includes(body.usageStatus)) {
      // Existing clients send a whole-line status. Derive the ledger decision
      // server-side under the caller's Order lock; never enable partial billing.
      const usedQty = body.usageStatus === PartUsageStatus.USED ? item.quantity : 0;
      // A stale client must not replace a partially recorded decision with
      // USED-for-all (which would otherwise bill additional approved pieces).
      if (row.state.events.some(event => event.type === 'USAGE_RECORDED') &&
          row.state.usedQty > 0 && row.state.usedQty < item.quantity) {
        throw new ConflictException('Linh kiện đã ghi số lượng thực dùng. Vui lòng tải lại và kiểm tra trước khi cập nhật.');
      }
      if (row.state.usedQty === usedQty && row.state.events.some(event => event.type === 'USAGE_RECORDED')) return 'replayed';
      body = { usedQty, expectedVersion: row.state.version, idempotencyKey: `tracking-usage:${item.id}:${body.usageStatus}` };
    }
    if (body.usedQty === undefined || body.expectedVersion === undefined || !body.idempotencyKey) throw new BadRequestException('Vui lòng gửi số lượng đã dùng, phiên bản và mã chống gửi trùng.');
    // Enrolled tracking-only rows may record partial usage. Only NEW invoices
    // consume ledger quantities; older non-enrolled parts remain whole-line.
    await lockCustodyTechnician(manager, row.technicianId);
    const result = await this.execute(manager, item.id, { kind: 'record_usage', partRequestId: request.id, partRequestItemId: item.id,
      usedQty: body.usedQty, expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey }, actor, order);
    // A replay must not reapply an old usage decision to the current item or its billing.
    if (result.replayed) return 'replayed';
    item.usageStatus = body.usedQty > 0 ? PartUsageStatus.USED : PartUsageStatus.RETURNED;
    return true;
  }

  private async execute(manager: EntityManager, itemId: string, command: PartCustodyCommand, actor: PartCustodyActor, order: ServiceOrder): Promise<{ response: Record<string, unknown>; replayed: boolean }> {
    const row = await manager.findOne(PartCustody, { where: { partRequestItemId: itemId }, lock: { mode: 'pessimistic_write' } });
    if (!row || row.partRequestId !== command.partRequestId) throw new NotFoundException();
    if ((command.kind === 'declare_return' || command.kind === 'record_usage') && row.technicianId !== actor.id) throw new ForbiddenException();
    const fingerprint = createHash('sha256').update(JSON.stringify({
      kind: command.kind, partRequestId: command.partRequestId, partRequestItemId: command.partRequestItemId,
      expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey,
      quantity: 'quantity' in command ? command.quantity : undefined,
      usedQty: command.kind === 'record_usage' ? command.usedQty : undefined,
      declaredQty: command.kind === 'report_discrepancy' ? command.declaredQty : undefined,
      observedQty: command.kind === 'report_discrepancy' ? command.observedQty : undefined,
      reason: command.reason,
      actorId: actor.id, role: actor.role,
    })).digest('hex');
    const prior = await manager.findOne(PartCustodyEntry, { where: { custodyId: row.id, idempotencyKey: command.idempotencyKey } });
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new ConflictException('Mã chống gửi trùng đã được dùng cho nội dung khác.');
      return { response: prior.response, replayed: true };
    }
    const frozen = Boolean(order.completionRequestedAt || await manager.findOne(Invoice, { where: { serviceOrderId: order.id } }));
    const now = new Date();
    try {
      const result = applyCustodyCommand({ ...row.state, serviceOrderStatus: order.status, invoiceFrozen: frozen }, command, actor, now);
      row.state = result.next;
    } catch (error) {
      if (!(error instanceof PartCustodyRuleError)) throw error;
      if (error.code === 'FORBIDDEN') throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này.');
      if (['INVALID_QUANTITY', 'INVALID_COMMAND'].includes(error.code)) throw new BadRequestException('Số lượng hoặc nội dung trả linh kiện không hợp lệ.');
      throw new ConflictException('Dữ liệu đã thay đổi hoặc số lượng vượt quá nghĩa vụ trả. Vui lòng tải lại.');
    }
    await manager.save(PartCustody, row);
    const response = this.view(row);
    await manager.insert(PartCustodyEntry, {
      custodyId: row.id, kind: command.kind as PartCustodyEntry['kind'], idempotencyKey: command.idempotencyKey,
      requestFingerprint: fingerprint, actorUserId: actor.id, actorRole: actor.role, occurredAt: now,
      quantity: command.kind === 'record_usage' ? command.usedQty : 'quantity' in command ? command.quantity : command.declaredQty,
      version: row.state.version, response,
    });
    return { response, replayed: false };
  }
}

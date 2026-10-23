import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PartSource, PartUsageStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PartCustody, PartCustodyEntry } from './entities/part-custody.entity';
import { PartRequest } from './entities/part-request.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { applyCustodyCommand, createPartCustodySnapshot, PartCustodyRuleError } from './part-custody.rules';
import { PartCustodyActor, PartCustodyCommand } from './part-custody.types';
import { custodyActivation, custodyTrackingEnabled, lockCustodyTechnician, partReturnsTrackingEnabled } from './part-custody.policy';
import { PartReturnDiscrepancyDto, PartReturnDto } from './dto/part-return.dto';

type Usage = { usedQty?: number; expectedVersion?: number; idempotencyKey?: string; usageStatus?: PartUsageStatus };

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
      return (await this.execute(manager, itemId, command, actor, order)).response;
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

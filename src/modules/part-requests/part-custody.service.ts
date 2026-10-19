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
import { custodyActivation, lockCustodyTechnician, p1CustodyEnabled } from './part-custody.policy';
import { PartReturnDto } from './dto/part-return.dto';

type Usage = { usedQty?: number; expectedVersion?: number; idempotencyKey?: string };

@Injectable()
export class PartCustodyService {
  constructor(private readonly dataSource: DataSource) {}

  /** Called ONLY by successful QR receive, in the same transaction as receivedAt. */
  async enrollHandover(manager: EntityManager, request: PartRequest, order: ServiceOrder): Promise<void> {
    const activation = await custodyActivation(manager);
    if (!activation || !request.receivedAt || request.receivedAt <= activation.activatedAt! ||
        [ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED].includes(order.status) ||
        order.completionRequestedAt || await manager.findOne(Invoice, { where: { serviceOrderId: order.id } })) return;
    await lockCustodyTechnician(manager, request.technicianId);
    for (const item of request.items) {
      if (item.partSource !== PartSource.FIXHOME) continue;
      const row = manager.create(PartCustody, {
        serviceOrderId: order.id, partRequestId: request.id, partRequestItemId: item.id,
        technicianId: request.technicianId, partNameSnapshot: item.partNameSnapshot,
        cohortActivatedAt: activation.activatedAt!, handedOverAt: request.receivedAt,
        state: createPartCustodySnapshot({
          serviceOrderId: order.id, partRequestId: request.id, partRequestItemId: item.id,
          requestType: request.requestType, additionalCostId: request.additionalCostId ?? null,
          partCatalogId: item.partCatalogId ?? null, source: item.partSource,
          originalCustodianTechnicianId: request.technicianId, issuedQty: item.quantity,
          usedQty: 0, serviceOrderStatus: order.status, invoiceFrozen: false,
        }),
      });
      await manager.save(PartCustody, row);
    }
  }

  private async requireActive(manager: EntityManager): Promise<void> {
    if (!await custodyActivation(manager)) throw new ServiceUnavailableException('Chức năng trả linh kiện chưa được mở.');
  }

  private view(row: PartCustody): Record<string, unknown> {
    const s = row.state;
    const declaredQty = s.declarations.reduce((sum, d) => sum + d.quantity, 0);
    return {
      id: row.id, orderId: row.serviceOrderId, partRequestId: row.partRequestId,
      partRequestItemId: row.partRequestItemId, technicianId: row.technicianId, partNameSnapshot: row.partNameSnapshot,
      issuedQty: s.issuedQty, usedQty: s.usedQty, declaredQty, managerAcceptedQty: s.managerAcceptedQty,
      outstandingQty: s.outstandingQty, version: s.version,
      returnStatus: s.returnDueQty === 0 ? 'not_required' : s.outstandingQty === 0 ? 'received' : s.managerAcceptedQty > 0 ? 'partially_received'
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
    if (actor.role !== Role.SERVICE_MANAGER) throw new ForbiddenException();
    await this.requireActive(this.dataSource.manager);
    const rows = await this.dataSource.manager.createQueryBuilder(PartCustody, 'c')
      .where("(c.state->>'outstandingQty')::int > 0")
      .andWhere("(SELECT COALESCE(sum((d->>'quantity')::int), 0) FROM jsonb_array_elements(c.state->'declarations') d) > (c.state->>'managerAcceptedQty')::int")
      .orderBy('c.handedOverAt', 'ASC').addOrderBy('c.id', 'ASC').take(100).getMany();
    return rows.map(row => this.view(row));
  }

  async command(requestId: string, itemId: string, kind: 'declare_return' | 'accept_return', body: PartReturnDto, actor: PartCustodyActor): Promise<Record<string, unknown>> {
    if (actor.role !== (kind === 'declare_return' ? Role.TECHNICIAN : Role.SERVICE_MANAGER)) throw new ForbiddenException();
    return this.dataSource.transaction(async manager => {
      await this.requireActive(manager);
      const reference = await manager.findOne(PartCustody, { where: { partRequestItemId: itemId, partRequestId: requestId } });
      if (!reference || reference.partRequestId !== requestId) throw new NotFoundException('Không tìm thấy linh kiện cần trả.');
      if (kind === 'declare_return' && reference.technicianId !== actor.id) throw new ForbiddenException();
      const order = await manager.findOne(ServiceOrder, { where: { id: reference.serviceOrderId }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new NotFoundException();
      await lockCustodyTechnician(manager, reference.technicianId);
      return (await this.execute(manager, itemId, { ...body, kind, partRequestId: requestId, partRequestItemId: itemId }, actor, order)).response;
    });
  }

  /** Existing usage route, with explicit quantities ONLY for enrolled items. Caller holds Order lock. */
  async recordUsage(manager: EntityManager, request: PartRequest, item: PartRequestItem, order: ServiceOrder, body: Usage, actor: PartCustodyActor): Promise<boolean | 'replayed'> {
    if (!p1CustodyEnabled()) return false;
    const row = await manager.findOne(PartCustody, { where: { partRequestItemId: item.id } });
    if (!row) return false;
    if (body.usedQty === undefined || body.expectedVersion === undefined || !body.idempotencyKey) throw new BadRequestException('Vui lòng gửi số lượng đã dùng, phiên bản và mã chống gửi trùng.');
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
      quantity: command.kind === 'record_usage' ? command.usedQty : 'quantity' in command ? command.quantity : 0,
      version: row.state.version, response,
    });
    return { response, replayed: false };
  }
}

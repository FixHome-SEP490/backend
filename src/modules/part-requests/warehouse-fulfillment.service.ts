import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, In } from 'typeorm';
import { AccountStatus, FulfillmentMethod, PartRequestStatus, PartRequestType, Role } from '../../shared/enums';
import { Notification } from '../notifications/entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities';
import { PartRequest, PartRequestItem } from './entities';
import { WarehouseAllocation } from './entities/warehouse-allocation.entity';
import { canonicalWarehouseQuantities, hasWholeRequestStock, warehouseBalance, WarehouseQuantity } from './warehouse-fulfillment.rules';

type Actor = { id: string; role: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eligibleRequestType = (type: PartRequestType) => [PartRequestType.PRE_REPAIR, PartRequestType.QUOTATION, PartRequestType.ADDITIONAL].includes(type);

/** Caller owns Order -> Technician -> PartRequest locks. All writes use that SAME manager. */
@Injectable()
export class WarehouseFulfillmentService {

  async allocation(manager: EntityManager, id: string): Promise<WarehouseAllocation | null> {
    return manager.findOne(WarehouseAllocation, { where: { partRequestId: id }, lock: { mode: 'pessimistic_write' },
      select: ['partRequestId', 'warehouseId', 'responsibleUserId', 'technicianId', 'status', 'tokenHash', 'tokenExpiresAt',
        'tokenVersion', 'receiptHash', 'receiptExpiresAt', 'handedOverAt', 'handedOverBy', 'receivedAt', 'createdAt'] });
  }

  async view(manager: EntityManager, id: string) {
    const a = await manager.findOne(WarehouseAllocation, { where: { partRequestId: id } });
    if (!a) return { partRequestId: id, mode: 'legacy', status: null };
    const w = a.warehouseId ? await manager.findOne(Warehouse, { where: { id: a.warehouseId } }) : null;
    return { partRequestId: id, mode: 'warehouse', status: a.status, warehouseId: a.warehouseId,
      warehouseName: w?.name ?? null, warehouseAddress: w?.address ?? null, responsibleUserId: w?.responsibleUserId ?? null,
      distanceNotVerified: true, reviewRequired: true, manualAssistanceReason: a.status === 'manual_assistance' ? 'NO_SINGLE_WAREHOUSE' : null,
      tokenExpiresAt: a.tokenExpiresAt, tokenVersion: a.tokenVersion, handedOverAt: a.handedOverAt, receivedAt: a.receivedAt };
  }

  async requireManager(manager: EntityManager, a: WarehouseAllocation, actor: Actor, bind = true) {
    if (actor.role !== Role.SERVICE_MANAGER || !a.warehouseId) throw new ForbiddenException('Chỉ quản lý kho được giao mới được xác nhận.');
    const w = await manager.findOne(Warehouse, { where: { id: a.warehouseId }, lock: { mode: 'pessimistic_read' } });
    if (!w || w.responsibleUserId !== actor.id || (bind && a.responsibleUserId !== actor.id)) throw new ForbiddenException('Bạn không phụ trách kho này.');
    if (!await manager.findOne(User, { where: { id: actor.id, role: Role.SERVICE_MANAGER, isActive: true, status: AccountStatus.ACTIVE }, lock: { mode: 'pessimistic_read' } })) {
      throw new ForbiddenException('Quản lý kho không còn hoạt động.');
    }
    return w;
  }

  private async command(manager: EntityManager, requestId: string, key: string, kind: string, actor: Actor, payload: unknown) {
    const fingerprint = digest({ requestId, key, kind, actorId: actor.id, role: actor.role, payload });
    const [prior] = await manager.query('SELECT id, fingerprint FROM warehouse_fulfillment_commands WHERE part_request_id=$1 AND command_key=$2', [requestId, key]);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ConflictException('Mã chống gửi trùng đã dùng cho nội dung khác.');
      return { id: prior.id as string, replayed: true };
    }
    const [saved] = await manager.query(`INSERT INTO warehouse_fulfillment_commands(part_request_id, command_key, kind, actor_user_id, fingerprint)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [requestId, key, kind, actor.role === 'system' ? null : actor.id, fingerprint]);
    return { id: saved.id as string, replayed: false };
  }

  /** Creates ONLY new PICKUP allocations. Historical requests never enter this method. */
  async enroll(manager: EntityManager, request: PartRequest, actor: Actor): Promise<void> {
    if (request.fulfillmentMethod !== FulfillmentMethod.PICKUP || !eligibleRequestType(request.requestType)) return;
    await manager.insert(WarehouseAllocation, { partRequestId: request.id, technicianId: request.technicianId,
      warehouseId: null, responsibleUserId: null, status: 'manual_assistance' });
    await this.reserve(manager, request, actor, `auto:${request.id}`, true);
  }

  async reserve(manager: EntityManager, request: PartRequest, actor: Actor, key: string, automatic = false) {
    if (!eligibleRequestType(request.requestType)) throw new ConflictException('Yêu cầu này tiếp tục dùng luồng cấp linh kiện riêng.');
    if (!automatic && ![Role.SERVICE_MANAGER, Role.ADMIN].includes(actor.role as Role)) throw new ForbiddenException();
    const a = await this.allocation(manager, request.id);
    if (!a || request.fulfillmentMethod !== FulfillmentMethod.PICKUP) throw new ConflictException('Yêu cầu lịch sử tiếp tục dùng quy trình cũ.');
    if (a.warehouseId && !automatic && actor.role === Role.SERVICE_MANAGER) await this.requireManager(manager, a, actor, false);
    const command = await this.command(manager, request.id, key, 'reserve', actor, {});
    if (command.replayed) return this.view(manager, request.id);
    if (request.status !== PartRequestStatus.REQUESTED || !['manual_assistance', 'reserved'].includes(a.status)) throw new ConflictException('Không thể giữ kho ở trạng thái này.');
    // SHARE locks stabilize active warehouse/manager selection; stock locks have global warehouse/SKU order.
    const candidates: { id: string; responsibleUserId: string }[] = await manager.query(`SELECT w.id, w.responsible_user_id AS "responsibleUserId"
      FROM warehouses w JOIN users u ON u.id=w.responsible_user_id
      WHERE w.status='active' AND u.role='service_manager' AND u.is_active AND u.status='active'
      ORDER BY w.id FOR SHARE OF w,u`);
    const required = canonicalWarehouseQuantities(request.items);
    const stocks: { warehouseId: string; partId: string; onHand: number; reserved: number }[] = candidates.length ? await manager.query(`
      SELECT s.warehouse_id AS "warehouseId", s.part_id AS "partId", s.on_hand AS "onHand", s.reserved
      FROM warehouse_stock s WHERE s.warehouse_id=ANY($1::uuid[]) AND s.part_id=ANY($2::uuid[])
      ORDER BY s.warehouse_id,s.part_id FOR UPDATE`, [candidates.map(w => w.id), required.map(i => i.partId)]) : [];
    const chosen = a.status === 'reserved' ? candidates.find(w => w.id === a.warehouseId) :
      candidates.find(w => hasWholeRequestStock(required, stocks.filter(s => s.warehouseId === w.id)));
    if (!automatic && actor.role === Role.SERVICE_MANAGER && chosen?.responsibleUserId !== actor.id) {
      if (chosen) throw new ForbiddenException('Bạn không phụ trách kho được chọn.');
    }
    if (a.status === 'reserved') return this.view(manager, request.id);
    if (!chosen) {
      const recipients = await manager.find(User, { where: { role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true } });
      if (recipients.length) await manager.insert(Notification, recipients.map(u => ({ userId: u.id, title: 'Yêu cầu linh kiện cần hỗ trợ',
        message: 'Chưa có một kho đủ toàn bộ linh kiện và quản lý đang hoạt động. Vui lòng hỗ trợ thủ công; chưa giữ tồn hoặc phát mã nhận.',
        type: 'PART_REQUEST_MANUAL_ASSISTANCE', referenceId: request.id, referenceType: 'part_request', isRead: false })));
      return this.view(manager, request.id);
    }
    a.warehouseId = chosen.id; a.responsibleUserId = chosen.responsibleUserId; a.status = 'reserved';
    await this.move(manager, a, required, 'RESERVE', command.id);
    await manager.save(WarehouseAllocation, a);
    await manager.insert(Notification, { userId: chosen.responsibleUserId, title: 'Yêu cầu linh kiện tại kho',
      message: 'Đã giữ đủ linh kiện tại kho bạn phụ trách. Khoảng cách chưa được xác minh; vui lòng kiểm tra trước khi chuẩn bị.',
      type: 'PART_REQUEST_NEW', referenceId: request.id, referenceType: 'part_request', isRead: false });
    return this.view(manager, request.id);
  }

  private token(a: WarehouseAllocation, phase: 'pickup' | 'receipt', raw: string) {
    return digest({ requestId: a.partRequestId, warehouseId: a.warehouseId, sm: a.responsibleUserId, tech: a.technicianId, version: a.tokenVersion, phase, raw });
  }

  async qr(manager: EntityManager, request: PartRequest, actor: Actor, key: string) {
    if (!eligibleRequestType(request.requestType)) throw new ConflictException('Yêu cầu này tiếp tục dùng luồng cấp linh kiện riêng.');
    const a = await this.allocation(manager, request.id);
    if (!a) throw new ConflictException('Yêu cầu không thuộc luồng kho mới.');
    const warehouse = await this.requireManager(manager, a, actor, false);
    if (warehouse.status !== 'active' && a.status !== 'handed_over') throw new ConflictException('Kho không hoạt động.');
    const command = await this.command(manager, request.id, key, 'qr', actor, {});
    if (command.replayed) return { allocation: await this.view(manager, request.id), qrToken: null };
    if (!['reserved','ready','handed_over'].includes(a.status)) throw new ConflictException('Chỉ phát mã khi đã giữ tồn hoặc chờ xác nhận nhận.');
    // A warehouse may get a new primary SM. Only its current manager can rotate;
    // rebind the new version so the outgoing manager's tokens cannot authorize issue.
    a.responsibleUserId = actor.id;
    const raw = randomBytes(32).toString('hex');
    if (a.status === 'handed_over') {
      a.tokenVersion++; a.receiptHash = this.token(a, 'receipt', raw); a.receiptExpiresAt = new Date(Date.now() + 48 * 3600_000);
      await manager.save(WarehouseAllocation, a);
      return { allocation: await this.view(manager, request.id), qrToken: raw };
    }
    a.tokenVersion++; a.tokenHash = this.token(a, 'pickup', raw); a.tokenExpiresAt = new Date(Date.now() + 15 * 60_000); a.status = 'ready';
    request.status = PartRequestStatus.READY; request.qrToken = null; request.qrGeneratedAt = null; request.preparedByUserId = actor.id;
    await manager.save(PartRequest, request); await manager.save(WarehouseAllocation, a);
    return { allocation: await this.view(manager, request.id), qrToken: raw };
  }

  async issue(manager: EntityManager, request: PartRequest, actor: Actor, body: { qrToken: string; idempotencyKey: string }, enrollCustody: (at: Date) => Promise<void>) {
    if (!eligibleRequestType(request.requestType)) throw new ConflictException('Yêu cầu này tiếp tục dùng luồng cấp linh kiện riêng.');
    const a = await this.allocation(manager, request.id);
    if (!a) throw new ConflictException('Yêu cầu không thuộc luồng kho mới.');
    const warehouse = await this.requireManager(manager, a, actor);
    const command = await this.command(manager, request.id, body.idempotencyKey, 'issue', actor, { tokenDigest: digest(body.qrToken) });
    if (command.replayed) return { allocation: await this.view(manager, request.id), qrToken: null };
    if (warehouse.status !== 'active' || a.status !== 'ready' || request.status !== PartRequestStatus.READY ||
        !a.tokenHash || !a.tokenExpiresAt || a.tokenExpiresAt.getTime() <= Date.now() || a.tokenHash !== this.token(a, 'pickup', body.qrToken)) {
      throw new ConflictException('Mã giao linh kiện sai, hết hạn hoặc đã sử dụng.');
    }
    // Persist physical proof first so the custody DB trigger can verify W2 admission.
    // Any enrollment failure rolls back issue, ledger, command and allocation together.
    const now = new Date();
    await this.move(manager, a, canonicalWarehouseQuantities(request.items), 'ISSUE', command.id);
    const raw = randomBytes(32).toString('hex');
    a.status = 'handed_over'; a.handedOverAt = now; a.handedOverBy = actor.id; a.tokenHash = null; a.tokenExpiresAt = null;
    a.receiptHash = this.token(a, 'receipt', raw); a.receiptExpiresAt = new Date(now.getTime() + 48 * 3600_000);
    await manager.save(WarehouseAllocation, a);
    await enrollCustody(now);
    return { allocation: await this.view(manager, request.id), qrToken: raw };
  }

  async acknowledge(manager: EntityManager, request: PartRequest, raw: string): Promise<boolean> {
    if (request.requestType === PartRequestType.WARRANTY) return false;
    const a = await this.allocation(manager, request.id);
    if (!a) return false;
    if (a.status !== 'handed_over' || a.technicianId !== request.technicianId || !a.receiptHash ||
        !a.receiptExpiresAt || a.receiptExpiresAt.getTime() <= Date.now() || a.receiptHash !== this.token(a, 'receipt', raw)) {
      throw new ConflictException('Cần quản lý kho bàn giao vật lý và mã nhận hợp lệ chưa sử dụng.');
    }
    a.status = 'received'; a.receivedAt = new Date(); a.receiptHash = null; a.receiptExpiresAt = null;
    await manager.save(WarehouseAllocation, a);
    return true;
  }

  async release(manager: EntityManager, request: PartRequest, actor: Actor): Promise<void> {
    if (request.requestType === PartRequestType.WARRANTY) return;
    const a = await this.allocation(manager, request.id);
    if (!a || ['handed_over','received','released'].includes(a.status)) return;
    const command = await this.command(manager, request.id, `release:${request.id}`, 'release', actor, {});
    if (command.replayed) return;
    if (a.warehouseId) {
      request.items = await manager.find(PartRequestItem, { where: { partRequestId: request.id } });
      await this.move(manager, a, canonicalWarehouseQuantities(request.items), 'RELEASE', command.id);
    }
    a.status = 'released'; a.tokenHash = null; a.tokenExpiresAt = null;
    await manager.save(WarehouseAllocation, a);
  }

  /** Called only after custody accepts physical receipt, never on a declaration or usage click. */
  async restockReturn(manager: EntityManager, requestId: string, item: PartRequestItem, body: { quantity: number; expectedVersion: number; idempotencyKey: string }, actor: Actor) {
    const a = await this.allocation(manager, requestId);
    if (!a) return;
    await this.requireManager(manager, a, actor, false);
    if (!['handed_over','received'].includes(a.status) || !item.partCatalogId) throw new ConflictException('Chưa có biên nhận xuất kho.');
    const command = await this.command(manager, requestId, `return:${item.id}:${body.idempotencyKey}`, 'return', actor,
      { itemId: item.id, quantity: body.quantity, expectedVersion: body.expectedVersion });
    if (!command.replayed) await this.move(manager, a, [{ partId: item.partCatalogId, quantity: body.quantity }], 'RETURN', command.id);
  }

  private async move(manager: EntityManager, a: WarehouseAllocation, required: WarehouseQuantity[], kind: 'RESERVE' | 'ISSUE' | 'RELEASE' | 'RETURN', commandId: string) {
    if (!a.warehouseId) throw new ConflictException('Chưa phân kho.');
    // Keep warehouse stable before stock locks, matching W1 stock adjustment.
    await manager.findOne(Warehouse, { where: { id: a.warehouseId }, lock: { mode: 'pessimistic_read' } });
    for (const item of required) {
      const [stock] = await manager.query(`SELECT on_hand AS "onHand", reserved FROM warehouse_stock
        WHERE warehouse_id=$1 AND part_id=$2 FOR UPDATE`, [a.warehouseId, item.partId]);
      if (!stock) throw new NotFoundException('Không tìm thấy tồn kho đã giữ.');
      const delta = kind === 'ISSUE' ? -item.quantity : kind === 'RETURN' ? item.quantity : 0;
      const reservationDelta = kind === 'RESERVE' ? item.quantity : kind === 'RETURN' ? 0 : -item.quantity;
      let balance: { onHand: number; reserved: number };
      try { balance = warehouseBalance(stock.onHand, stock.reserved, delta, reservationDelta); }
      catch { throw new ConflictException('Tồn kho đã thay đổi hoặc không đủ.'); }
      await manager.query(`UPDATE warehouse_stock SET on_hand=$3, reserved=$4, version=version+1, updated_at=now()
        WHERE warehouse_id=$1 AND part_id=$2`, [a.warehouseId, item.partId, balance.onHand, balance.reserved]);
      await manager.query(`INSERT INTO warehouse_fulfillment_movements(command_id,warehouse_id,part_id,kind,delta,reservation_delta,on_hand_after,reserved_after)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [commandId, a.warehouseId, item.partId, kind, delta, reservationDelta, balance.onHand, balance.reserved]);
    }
  }
}

/** Bulk lifecycle callers already hold the Order lock. No new transaction or connection.
 * Only W2 rows take the additional locks; historical requests never mutate warehouse stock. */
export async function releaseWarehouseReservations(manager: EntityManager, where: FindOptionsWhere<PartRequest>): Promise<void> {
  const requests = (await manager.find(PartRequest, { where, order: { technicianId: 'ASC', id: 'ASC' } }))
    .filter(request => request.requestType !== PartRequestType.WARRANTY);
  if (!requests.length) return;
  const allocations = await manager.find(WarehouseAllocation, { where: { partRequestId: In(requests.map(r => r.id)), status: In(['manual_assistance','reserved','ready']) } });
  if (!allocations.length) return;
  const pending = requests.filter(r => allocations.some(a => a.partRequestId === r.id));
  const fulfillment = new WarehouseFulfillmentService();
  // All technician locks precede every Request/Allocation/Warehouse/SKU lock.
  for (const id of [...new Set(pending.map(r => r.technicianId))].sort()) {
    if (!await manager.findOne(User, { where: { id }, lock: { mode: 'pessimistic_write' } })) throw new NotFoundException();
  }
  for (const request of pending) {
    await manager.findOne(PartRequest, { where: { id: request.id }, lock: { mode: 'pessimistic_write' } });
  }
  const locked: WarehouseAllocation[] = [];
  for (const request of pending) {
    const allocation = await fulfillment.allocation(manager, request.id);
    if (allocation && ['reserved','ready'].includes(allocation.status)) locked.push(allocation);
  }
  // A bulk close can span several warehouse requests: lock the UNION in global stock order,
  // rather than acquiring request A's stock followed by request B's possibly earlier SKU.
  const warehouseIds = [...new Set(locked.map(a => a.warehouseId!))].sort();
  if (warehouseIds.length) {
    await manager.query('SELECT id FROM warehouses WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [warehouseIds]);
    const items = await manager.find(PartRequestItem, { where: { partRequestId: In(locked.map(a => a.partRequestId)) } });
    const partIds = [...new Set(items.map(i => i.partCatalogId).filter((id): id is string => !!id))].sort();
    await manager.query(`SELECT warehouse_id,part_id FROM warehouse_stock WHERE warehouse_id=ANY($1::uuid[])
      AND part_id=ANY($2::uuid[]) ORDER BY warehouse_id,part_id FOR UPDATE`, [warehouseIds, partIds]);
  }
  for (const request of pending) {
    await fulfillment.release(manager, request, { id: request.technicianId, role: 'system' });
  }
}

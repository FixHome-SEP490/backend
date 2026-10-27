import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { ServiceOrdersService } from './service-orders.service';
import { AccountStatus, AdditionalCostStatus, BookingStatus, EvidenceType, PartRequestStatus, PartRequestType, PartSource, PartUsageStatus, QuotationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { applyCustodyCommand, createPartCustodySnapshot } from '../part-requests/part-custody.rules';
import { AuditLogService } from '../audit-log/audit-log.service';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RepairFailedDto } from './dto/repair-failed.dto';
import { QuotationsService } from '../quotations/quotations.service';

// Repository boundary only: reportRepairFailed, authorization, transition and
// both stock lifecycle helpers execute unchanged against these persisted rows.
function fixture() {
  const rows: Record<string, any[]> = {
    Booking: [{ id: 'booking', customerId: 'customer', visitGroupId: 'group', status: BookingStatus.MATCHED }],
    ServiceOrder: [{ id: 'order', bookingId: 'booking', code: 'FH-TEST', status: ServiceOrderStatus.UNDER_REPAIR }],
    TechnicianAssignment: [{ id: 'assignment', serviceOrderId: 'order', technicianId: 'tech', isActive: true }],
    PartRequest: [
      ...['tech', 'previous-tech'].map((technicianId, i) => ({ id: `received-${i}`, serviceOrderId: 'order', technicianId, status: PartRequestStatus.RECEIVED, items: [{ id: `item-${i}`, quantity: 1, usageStatus: PartUsageStatus.PENDING }] })),
      ...[PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING].map(status => ({ id: status, serviceOrderId: 'order', technicianId: 'tech', status })),
      { id: 'previous-outgoing', serviceOrderId: 'order', technicianId: 'previous-tech', status: PartRequestStatus.READY },
    ],
    VisitGroupItem: [{ id: 'item', bookingId: 'booking', groupId: 'group', sequence: 1, outcome: 'pending' }],
    Quotation: [{ serviceOrderId: 'order', technicianId: 'tech', status: QuotationStatus.APPROVED }],
    PartCustody: [{ serviceOrderId: 'order', trackingOnly: true, state: { outstandingQty: 2, managerAcceptedQty: 0 } }],
    User: [{ id: 'admin', role: Role.ADMIN, status: AccountStatus.ACTIVE, isActive: true }, { id: 'manager', role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true }],
  };
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]) => {
    if (value instanceof FindOperator) return value.type === 'in' ? value.value.includes(row[key]) : row[key] !== value.value;
    return row[key] === value;
  });
  const table = (entity: { name: string }) => rows[entity.name] ??= [];
  const manager: any = {
    find: vi.fn(async (entity, options) => table(entity).filter(row => matches(row, options?.where))),
    findOne: vi.fn(async (entity, options) => table(entity).find(row => matches(row, options?.where)) ?? null),
    findOneBy: vi.fn(async (entity, where) => table(entity).find(row => matches(row, where)) ?? null),
    findOneOrFail: vi.fn(async (entity, options) => table(entity).find(row => matches(row, options.where))),
    findOneByOrFail: vi.fn(async (entity, where) => table(entity).find(row => matches(row, where))),
    count: vi.fn(async (entity, options) => table(entity).filter(row => matches(row, options?.where)).length),
    update: vi.fn(async (entity, where, patch) => {
      const selected = table(entity).filter(row => matches(row, typeof where === 'string' ? { id: where } : where));
      selected.forEach(row => Object.assign(row, patch));
      return { affected: selected.length };
    }),
    create: (_entity: any, value: any) => value,
    save: vi.fn(async (entity, value) => { const saved = { id: `saved-${table(entity).length}`, ...value }; table(entity).push(saved); return saved; }),
    insert: vi.fn(async (entity, value) => { table(entity).push(...(Array.isArray(value) ? value : [value])); }),
    createQueryBuilder: () => { const qb: any = {}; for (const key of ['update', 'set', 'where']) qb[key] = () => qb; qb.execute = async () => ({ affected: 0 }); return qb; },
  };
  let transactions = Promise.resolve();
  const transaction = (callback: any) => {
    const result = transactions.then(async () => {
      const before = structuredClone(rows);
      try { return await callback(manager); }
      catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, before); throw error; }
    });
    transactions = result.then(() => undefined, () => undefined);
    return result;
  };
  const service = Object.create(ServiceOrdersService.prototype) as ServiceOrdersService;
  Object.assign(service, { dataSource: { manager, transaction }, auditLogService: new AuditLogService({} as never) });
  const dto = { reason: 'beyond_repair' as const, parts: [{ partRequestId: 'received-0', outcome: 'returned' as const }] };
  return { service, rows, manager, dto, actor: { id: 'tech', role: Role.TECHNICIAN } };
}

describe('repair failure custody regression', () => {
  it('still requires a separate physical declaration and manager acceptance after failure', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.PartCustody[0].state = createPartCustodySnapshot({ serviceOrderId: 'order', partRequestId: 'received-0', partRequestItemId: 'item-0', requestType: PartRequestType.PRE_REPAIR, additionalCostId: null, partCatalogId: 'catalog', source: PartSource.FIXHOME, originalCustodianTechnicianId: actor.id, issuedQty: 2, usedQty: 0, serviceOrderStatus: ServiceOrderStatus.UNDER_REPAIR, invoiceFrozen: false });
    await service.reportRepairFailed('order', dto, actor);
    const snapshot = { ...rows.PartCustody[0].state, serviceOrderStatus: rows.ServiceOrder[0].status };
    expect(snapshot).toMatchObject({ outstandingQty: 2, managerAcceptedQty: 0, receipts: [], declarations: [] });
    const command = { partRequestId: 'received-0', partRequestItemId: 'item-0', quantity: 2 };
    const declared = applyCustodyCommand(snapshot, { ...command, kind: 'declare_return', expectedVersion: 0, idempotencyKey: 'return-failed-01' }, actor, new Date().toISOString());
    expect(declared.next).toMatchObject({ outstandingQty: 2, managerAcceptedQty: 0 });
    const accepted = applyCustodyCommand(declared.next, { ...command, kind: 'accept_return', expectedVersion: 1, idempotencyKey: 'accept-failed-01' }, { id: 'manager', role: Role.SERVICE_MANAGER }, new Date().toISOString());
    expect(accepted.next).toMatchObject({ outstandingQty: 0, managerAcceptedQty: 2 });
  });

  it('preserves every RECEIVED request and outstanding warehouse acceptance through the actual cancellation transition', async () => {
    const { service, rows, dto, actor } = fixture();
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.CANCELLED);
    expect(rows.PartRequest.slice(0, 2).map(row => row.status)).toEqual([PartRequestStatus.RECEIVED, PartRequestStatus.RECEIVED]);
    expect(rows.PartCustody[0].state).toEqual({ outstandingQty: 2, managerAcceptedQty: 0 });
    expect(rows.PartRequest.slice(0, 2).map(row => row.items[0].usageStatus)).toEqual([PartUsageStatus.PENDING, PartUsageStatus.PENDING]);
    expect(rows.PartRequest.slice(2).map(row => row.status)).toEqual(Array(4).fill(PartRequestStatus.CANCELLED));
  });

  it('keeps ordinary cancellation stock behavior', async () => {
    const { service, manager, rows, actor } = fixture();
    await (service as any).commitTransition(manager, rows.ServiceOrder[0], ServiceOrderStatus.CANCELLED, actor, 'Ordinary cancellation');
    expect(rows.PartRequest.every(row => row.status === PartRequestStatus.CANCELLED)).toBe(true);
  });

  it('does not acquire a booking or order lock for a technician without assignment or an owned replay incident', async () => {
    const { service, manager, actor, dto } = fixture();
    await expect(service.reportRepairFailed('order', dto, { ...actor, id: 'outsider' })).rejects.toThrow();
    expect(manager.findOneOrFail).not.toHaveBeenCalled();
    expect(manager.findOne.mock.calls.some(([, options]) => options?.lock)).toBe(false);
  });
});

describe('repair failure incident', () => {
  it('dispatches the persisted incident after commit without undoing a failed voucher delivery', async () => {
    const { service, rows, dto, actor } = fixture();
    const issueAutoCompensation = vi.fn(async (incidentId: string) => {
      expect(rows.SupportCase[0].id).toBe(incidentId);
      expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.CANCELLED);
      throw new Error('voucher temporarily unavailable');
    });
    (service as any).vouchersService = { issueAutoCompensation };
    await service.reportRepairFailed('order', dto, actor);
    expect(issueAutoCompensation).toHaveBeenCalledTimes(1);
    expect(rows.SupportCase).toHaveLength(1);
  });
  it('cannot approve a pending addition after the failed order has closed', async () => {
    const { service, rows, manager, dto, actor } = fixture();
    rows.AdditionalCostRequest = [{ id: 'addition', serviceOrderId: 'order', status: AdditionalCostStatus.PENDING_APPROVAL, expiresAt: new Date('2030-01-01') }];
    await service.reportRepairFailed('order', dto, actor);
    const quotations = Object.assign(Object.create(QuotationsService.prototype), {
      dataSource: { transaction: (work: any) => work(manager) },
      additionalCostRepo: { findOneBy: async () => rows.AdditionalCostRequest[0] },
    }) as QuotationsService;
    await expect(quotations.decideAdditionalCost('addition', 'APPROVE', { id: 'customer', role: Role.CUSTOMER })).rejects.toThrow('Chi phí phát sinh không còn chờ duyệt hoặc đơn đã chốt hóa đơn.');
    expect(rows.AdditionalCostRequest[0].status).toBe(AdditionalCostStatus.CANCELLED);
    expect(rows.ServiceOrder[0].grandTotal).toBe(0);
  });

  it('sends incident notices only to active staff accounts', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.User.push({ id: 'disabled', role: Role.ADMIN, status: AccountStatus.ACTIVE, isActive: false });
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.Notification.map(row => row.userId).sort()).toEqual(['admin', 'customer', 'manager']);
  });

  it('ends a solo repair at zero without invoice, reputation change or automatic stock return', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.Booking[0].visitGroupId = null;
    rows.ServiceOrder[0].grandTotal = 450000;
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.ServiceOrder[0]).toMatchObject({ status: ServiceOrderStatus.CANCELLED, laborTotal: 0, partsTotal: 0, grandTotal: 0 });
    expect(rows.SupportCase).toHaveLength(1);
    expect(rows.TechnicianAssignment[0].isActive).toBe(false);
    expect(rows.Invoice ?? []).toHaveLength(0);
    expect(rows.CancellationStrike ?? []).toHaveLength(0);
    expect(rows.ReputationEvent ?? []).toHaveLength(0);
  });

  it.each([1, 2])('isolates failed child at sequence %i including a failed lead', async sequence => {
    const { service, rows, dto, actor } = fixture();
    rows.VisitGroupItem[0].sequence = sequence;
    rows.Booking.push({ id: 'sibling', visitGroupId: 'group', status: BookingStatus.MATCHED });
    rows.ServiceOrder.push({ id: 'sibling-order', bookingId: 'sibling', status: ServiceOrderStatus.UNDER_REPAIR });
    rows.VisitGroupItem.push({ bookingId: 'sibling', outcome: 'succeeded' });
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.VisitGroupItem.map(row => row.outcome)).toEqual(['failed', 'succeeded']);
    expect(rows.Booking[1].status).toBe(BookingStatus.MATCHED);
    expect(rows.ServiceOrder[1].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(rows.TechnicianAssignment[0].isActive).toBe(false);
  });

  it('keeps the sibling assignment active when only the failed child is released', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.TechnicianAssignment.push({ id: 'sibling-assignment', serviceOrderId: 'sibling-order', technicianId: 'tech', isActive: true });
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.TechnicianAssignment.map(row => row.isActive)).toEqual([false, true]);
  });

  it('requires a previously recorded full USED outcome before an installed declaration closes the order', async () => {
    const { service, rows, dto, actor } = fixture();
    const installed = { ...dto, parts: [{ partRequestId: 'received-0', outcome: 'installed' as const }] };
    await expect(service.reportRepairFailed('order', installed, actor)).rejects.toThrow();
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    rows.PartRequest[0].items[0].usageStatus = PartUsageStatus.USED;
    rows.PartCustody[0].partRequestItemId = 'item-0';
    rows.PartCustody[0].state = { issuedQty: 1, usedQty: 0, outstandingQty: 1 };
    await expect(service.reportRepairFailed('order', installed, actor)).rejects.toThrow();
    rows.PartCustody[0].state.usedQty = 1;
    await service.reportRepairFailed('order', installed, actor);
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.CANCELLED);
  });

  it('rejects a return declaration for a line already recorded as USED', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.PartRequest[0].items[0].usageStatus = PartUsageStatus.USED;
    await expect(service.reportRepairFailed('order', dto, actor)).rejects.toThrow();
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('cancels only pending additions and persists one customer/Admin/SM notice with a stable incident source', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.AdditionalCostRequest = [AdditionalCostStatus.PENDING_APPROVAL, AdditionalCostStatus.APPROVED].map(status => ({ serviceOrderId: 'order', status }));
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.AdditionalCostRequest.map(row => row.status)).toEqual([AdditionalCostStatus.CANCELLED, AdditionalCostStatus.APPROVED]);
    expect(rows.Notification.map(row => row.userId).sort()).toEqual(['admin', 'customer', 'manager']);
    expect(rows.Notification.filter(row => row.userId !== 'customer').every(row => row.referenceId === rows.SupportCase[0].id)).toBe(true);
    expect(rows.AuditLog.find(row => row.action === 'VISIT_DEVICE_REPAIR_FAILED').after).toMatchObject({ incidentId: rows.SupportCase[0].id, version: 1 });
  });

  it('replays the same solo report after assignment closure without duplicating side effects and rejects changed retry', async () => {
    const { service, rows, dto, actor } = fixture();
    rows.Booking[0].visitGroupId = null;
    await service.reportRepairFailed('order', dto, actor);
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.SupportCase).toHaveLength(1);
    expect(rows.Notification).toHaveLength(3);
    expect(rows.OrderStatusHistory).toHaveLength(1);
    await expect(service.reportRepairFailed('order', { ...dto, reason: 'other' }, actor)).rejects.toThrow();
    await expect(service.reportRepairFailed('order', dto, { id: 'previous-tech', role: Role.TECHNICIAN })).rejects.toThrow();
  });

  it.each([ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED])('rejects status %s', async status => {
    const { service, rows, dto, actor } = fixture();
    rows.ServiceOrder[0].status = status;
    await expect(service.reportRepairFailed('order', dto, actor)).rejects.toThrow();
    expect(rows.SupportCase ?? []).toHaveLength(0);
  });

  it.each([Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER])('rejects reporting role %s', async role => {
    const { service, rows, dto } = fixture();
    await expect(service.reportRepairFailed('order', dto, { id: 'tech', role })).rejects.toThrow();
    expect(rows.SupportCase ?? []).toHaveLength(0);
  });

  it.each(['invoice', 'completion', 'pending quote', 'unapproved quote'])('fails closed with %s', async gate => {
    const { service, rows, dto, actor } = fixture();
    if (gate === 'invoice') rows.Invoice = [{ serviceOrderId: 'order' }];
    if (gate === 'completion') rows.ServiceOrder[0].completionRequestedAt = new Date();
    if (gate === 'pending quote') rows.Quotation = [{ serviceOrderId: 'order', status: QuotationStatus.SENT }];
    if (gate === 'unapproved quote') rows.Quotation = [];
    await expect(service.reportRepairFailed('order', dto, actor)).rejects.toThrow();
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('links up to three owned private additional photos by ID', async () => {
    const { service, rows, dto, actor } = fixture();
    const photoEvidenceIds = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000000${n}`);
    rows.RepairEvidence = photoEvidenceIds.map(id => ({ id, serviceOrderId: 'order', uploaderId: actor.id, type: EvidenceType.ADDITIONAL, mimeType: 'image/jpeg', mediaUrl: `cloudinary://evidence/fixhome/evidence/order/tech/${id}` }));
    await service.reportRepairFailed('order', { ...dto, photoEvidenceIds } as RepairFailedDto, actor);
    expect(rows.SupportCase[0].evidenceRefs).toEqual(photoEvidenceIds);
  });

  it.each(['foreign order', 'foreign uploader', 'public URL', 'face', 'missing'])('rejects photo %s', async bad => {
    const { service, rows, dto, actor } = fixture();
    const id = '00000000-0000-4000-8000-000000000001';
    rows.RepairEvidence = bad === 'missing' ? [] : [{ id, serviceOrderId: bad === 'foreign order' ? 'other' : 'order', uploaderId: bad === 'foreign uploader' ? 'other' : actor.id, type: bad === 'face' ? EvidenceType.CHECKIN_FACE : EvidenceType.ADDITIONAL, mimeType: 'image/jpeg', mediaUrl: bad === 'public URL' ? 'https://example.com/photo.jpg' : `cloudinary://evidence/fixhome/evidence/order/tech/${id}` }];
    await expect(service.reportRepairFailed('order', { ...dto, photoEvidenceIds: [id] } as RepairFailedDto, actor)).rejects.toThrow();
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('requires reason and rejects four or duplicate photos at the HTTP DTO boundary', async () => {
    expect(await validate(plainToInstance(RepairFailedDto, {}))).not.toHaveLength(0);
    const photoEvidenceIds = Array(4).fill('00000000-0000-4000-8000-000000000001');
    expect(await validate(plainToInstance(RepairFailedDto, { reason: 'other', photoEvidenceIds }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(RepairFailedDto, { reason: 'other', photoEvidenceIds: photoEvidenceIds.slice(0, 2) }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(RepairFailedDto, { reason: 'other', photoEvidenceIds: [] }))).toHaveLength(0);
  });

  it.each(['AuditLog', 'Notification'])('rolls back the report when durable %s insertion fails', async entityName => {
    const { service, rows, manager, dto, actor } = fixture();
    const insert = manager.insert.getMockImplementation();
    manager.insert.mockImplementation(async (entity: any, value: any) => {
      if (entity.name === entityName && (entityName !== 'AuditLog' || value.action === 'VISIT_DEVICE_REPAIR_FAILED')) throw new Error('persistence failed');
      return insert(entity, value);
    });
    await expect(service.reportRepairFailed('order', dto, actor)).rejects.toThrow('persistence failed');
    expect(rows.ServiceOrder[0].status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(rows.PartRequest[0].status).toBe(PartRequestStatus.RECEIVED);
    expect(rows.SupportCase ?? []).toHaveLength(0);
    expect(rows.Notification ?? []).toHaveLength(0);
  });

  it('creates one incident for two requests serialized by the transaction boundary (not a PostgreSQL concurrency proof)', async () => {
    const { service, rows, dto, actor } = fixture();
    await Promise.all([service.reportRepairFailed('order', dto, actor), service.reportRepairFailed('order', dto, actor)]);
    expect(rows.SupportCase).toHaveLength(1);
    expect(rows.Notification).toHaveLength(3);
  });

  it('replays after jsonb has reordered persisted object keys', async () => {
    const { service, rows, dto, actor } = fixture();
    await service.reportRepairFailed('order', dto, actor);
    const receipt = rows.AuditLog.find(row => row.action === 'VISIT_DEVICE_REPAIR_FAILED');
    const request = receipt.after.request;
    receipt.after.request = { photoEvidenceIds: request.photoEvidenceIds, parts: request.parts.map((part: any) => ({ outcome: part.outcome, partRequestId: part.partRequestId })), note: request.note, reason: request.reason };
    await service.reportRepairFailed('order', dto, actor);
    expect(rows.SupportCase).toHaveLength(1);
  });
});

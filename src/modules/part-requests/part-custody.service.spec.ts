import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { PartCustodyService } from './part-custody.service';
import { PartRequestsService } from './part-requests.service';
import { usedPartQuantities } from './part-request-lifecycle';
import { PartCustody, PartCustodyActivation, PartCustodyEntry } from './entities/part-custody.entity';
import { PartRequest } from './entities/part-request.entity';
import { PartRequestItem } from './entities/part-request-item.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { hasPartReturnRestriction } from './part-custody.policy';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { PartRequestStatus, PartRequestType, PartSource, PartUsageStatus, Role, ServiceOrderStatus } from '../../shared/enums';

const tech = { id: 'tech', role: Role.TECHNICIAN };
const managerActor = { id: 'manager', role: Role.SERVICE_MANAGER };
const body = (quantity = 1, expectedVersion = 1, idempotencyKey = 'return-key-01') => ({ quantity, expectedVersion, idempotencyKey });

describe('persistent P1 custody', () => {
  let service: PartCustodyService;
  let rows: PartCustody[];
  let entries: PartCustodyEntry[];
  let db: any;
  let request: any;
  let order: any;
  let frozen: boolean;
  beforeEach(() => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    rows = []; entries = []; frozen = false;
    order = { id: 'order', status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: null };
    request = { id: 'request', serviceOrderId: 'order', technicianId: tech.id, requestType: PartRequestType.PRE_REPAIR,
      receivedAt: new Date(), items: [{ id: 'item', partRequestId: 'request', partCatalogId: 'catalog', partSource: PartSource.FIXHOME, quantity: 3, usageStatus: PartUsageStatus.PENDING, partNameSnapshot: 'Part' }] };
    db = {
      findOne: vi.fn(async (entity, options) => {
        if (entity === PartCustodyActivation) return { id: 1, enabled: true, activatedAt: new Date('2026-01-01T00:00:00Z') };
        if (entity === ServiceOrder) return order;
        if (entity === Invoice) return frozen ? { id: 'invoice' } : null;
        if (entity === PartRequest) return request;
        if (entity === PartRequestItem) return request.items[0];
        if (entity === Quotation) return { id: 'quote', items: [{ partSource: PartSource.FIXHOME, partCatalogId: 'catalog', quantity: 3 }] };
        if (entity === PartCustody) return rows.find(row => row.partRequestItemId === options.where.partRequestItemId) ?? null;
        if (entity === PartCustodyEntry) return entries.find(row => row.custodyId === options.where.custodyId && row.idempotencyKey === options.where.idempotencyKey) ?? null;
        return { id: tech.id };
      }),
      find: vi.fn(async (entity, options) => entity === PartCustody ? rows.filter(row => !options?.where?.serviceOrderId || row.serviceOrderId === options.where.serviceOrderId) : entity === PartRequest ? [request] : []),
      create: vi.fn((_entity, value) => value),
      save: vi.fn(async (entity, value) => {
        if (entity === PartCustody && !rows.includes(value)) { value.id = 'custody'; rows.push(value); }
        return value;
      }),
      insert: vi.fn(async (_entity, value) => { entries.push(value); }),
    };
    service = new PartCustodyService({ transaction: async cb => cb(db), manager: db } as unknown as DataSource);
  });
  afterEach(() => vi.unstubAllEnvs());
  const enroll = () => service.enrollHandover(db, request, order);

  const tracking = () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    order.createdAt = new Date('2026-02-01T00:00:00Z');
  };
  it('tracks only new orders handed over after activation with finance P1 OFF', async () => {
    tracking();
    order.createdAt = new Date('2025-12-31T00:00:00Z');
    await enroll(); expect(rows).toHaveLength(0);
    order.createdAt = new Date('2026-02-01T00:00:00Z');
    await enroll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trackingOnly: true, state: { outstandingQty: 3 } });
  });
  it('P013 enrolls linked QUOTATION QR stock in tracking-only mode without finance P1', async () => {
    tracking();
    request.requestType = PartRequestType.QUOTATION;
    request.quotationId = 'quote';
    await enroll();
    expect(rows[0]).toMatchObject({ trackingOnly: true, state: { requestType: 'quotation', quotationId: 'quote', additionalCostId: null } });
    await service.recordUsage(db, request, request.items[0], order, { usageStatus: PartUsageStatus.RETURNED }, tech);
    expect(rows[0].state).toMatchObject({ usedQty: 0, outstandingQty: 3 });
    expect(process.env.P1_CUSTODY_ENABLED).toBe('false');
  });
  it.each([PartUsageStatus.RETURNED, PartUsageStatus.USED])('accepts existing status-only %s for tracking without changing invoice quantities', async usageStatus => {
    tracking(); await enroll(); request.status = PartRequestStatus.RECEIVED;
    const parts = Object.assign(Object.create(PartRequestsService.prototype), {
      dataSource: { transaction: async cb => cb(db) }, custodyService: service,
      auditLogService: { logWithManager: vi.fn() },
    }) as PartRequestsService;
    vi.spyOn(parts as any, 'lockRequest').mockResolvedValue({ request, order });
    expect(await parts.updateItemUsage('request', 'item', { usageStatus }, tech)).toMatchObject({ usageStatus, quantity: 3 });
    expect(rows[0].state).toMatchObject(usageStatus === PartUsageStatus.RETURNED ? { usedQty: 0, outstandingQty: 3 } : { usedQty: 3, outstandingQty: 0 });
    await parts.updateItemUsage('request', 'item', { usageStatus }, tech);
    expect(entries).toHaveLength(1);
  });
  it('keeps tracking usage compatible with legacy billing and freezes the decision after declaring returns', async () => {
    tracking(); await enroll();
    const usage = { usedQty: 2, expectedVersion: 0, idempotencyKey: 'usage-partial-01' };
    await expect(service.recordUsage(db, request, request.items[0], order, usage, tech)).rejects.toMatchObject({ status: 400 });
    await service.recordUsage(db, request, request.items[0], order, { ...usage, usedQty: 0 }, tech);
    expect(request.items[0].usageStatus).toBe(PartUsageStatus.RETURNED);
    await service.command('request', 'item', 'declare_return', body(3, 1), tech);
    await expect(service.recordUsage(db, request, request.items[0], order, { ...usage, usedQty: 3, expectedVersion: 2 }, tech)).rejects.toMatchObject({ status: 409 });
  });
  it('allows physical receipts after customer completion; partial and missing receipts retain the obligation', async () => {
    tracking(); await enroll();
    db.query = vi.fn(async (_sql, params) => [{ blocked: rows.some(row => row.technicianId === params[0] && row.trackingOnly && row.state.outstandingQty > 0) }]);
    expect(await hasPartReturnRestriction(db, tech.id)).toBe(true);
    await service.recordUsage(db, request, request.items[0], order, { usedQty: 0, expectedVersion: 0, idempotencyKey: 'usage-return-01' }, tech);
    order.status = ServiceOrderStatus.COMPLETED; frozen = true;
    await service.command('request', 'item', 'declare_return', body(3, 1), tech);
    const first = await service.command('request', 'item', 'accept_return', body(1, 2, 'receipt-first-01'), managerActor);
    expect(first).toMatchObject({ outstandingQty: 2, returnStatus: 'partially_received', trackingOnly: true });
    expect(await hasPartReturnRestriction(db, tech.id)).toBe(true);
    expect(await service.command('request', 'item', 'accept_return', body(1, 2, 'receipt-first-01'), managerActor)).toEqual(first);
    const last = await service.command('request', 'item', 'accept_return', body(2, 3, 'receipt-final-01'), managerActor);
    expect(last).toMatchObject({ outstandingQty: 0, returnStatus: 'received' });
    expect(await hasPartReturnRestriction(db, tech.id)).toBe(false);
    expect(order.status).toBe(ServiceOrderStatus.COMPLETED);
    expect(frozen).toBe(true);
  });
  it('lists undeclared obligations for managers and filters the technician queue to the original owner', async () => {
    tracking(); await enroll();
    let owner: string | undefined;
    const query = {
      where: vi.fn(() => query),
      andWhere: vi.fn((_sql, params) => { owner = params.technicianId; return query; }),
      orderBy: vi.fn(() => query), addOrderBy: vi.fn(() => query), take: vi.fn(() => query),
      getMany: vi.fn(async () => rows.filter(row => row.state.outstandingQty > 0 && (!owner || row.technicianId === owner))),
    };
    db.createQueryBuilder = vi.fn(() => { owner = undefined; return query; });
    expect(await service.pending(managerActor)).toHaveLength(1);
    expect(await service.pending(tech)).toHaveLength(1);
    expect(await service.pending({ id: 'other', role: Role.TECHNICIAN })).toEqual([]);
    await expect(service.pending({ id: 'customer', role: Role.CUSTOMER })).rejects.toMatchObject({ status: 403 });
  });
  it('can stop new enrollment without hiding existing tracking obligations or preventing receipt', async () => {
    tracking(); await enroll();
    await service.command('request', 'item', 'declare_return', body(3, 0), tech);
    const original = db.findOne.getMockImplementation();
    db.findOne.mockImplementation(async (entity, options) => entity === PartCustodyActivation
      ? { enabled: false, activatedAt: new Date('2026-01-01T00:00:00Z') } : original(entity, options));
    expect(await service.byOrder('order', tech)).toHaveLength(1);
    expect(await service.command('request', 'item', 'accept_return', body(3, 1, 'accept-paused-01'), managerActor)).toMatchObject({ outstandingQty: 0 });
    rows.length = 0;
    await enroll(); expect(rows).toHaveLength(0);
  });
  it('records damaged or missing returns as an exception without accepting stock or clearing debt', async () => {
    tracking(); await enroll();
    await service.command('request', 'item', 'declare_return', body(3, 0), tech);
    const exception = { declaredQty: 3, observedQty: 0, expectedVersion: 1, idempotencyKey: 'damaged-return-01', reason: 'Linh kiện bị hỏng' };
    const result = await service.command('request', 'item', 'report_discrepancy', exception, managerActor);
    expect(result).toMatchObject({ outstandingQty: 3, managerAcceptedQty: 0, returnStatus: 'exception', discrepancies: [{ declaredQty: 3, observedQty: 0 }] });
    expect(await service.command('request', 'item', 'report_discrepancy', exception, managerActor)).toEqual(result);
    await expect(service.command('request', 'item', 'report_discrepancy', { ...exception, observedQty: 1 }, managerActor)).rejects.toMatchObject({ status: 409 });
    await expect(service.command('request', 'item', 'report_discrepancy', exception, tech)).rejects.toMatchObject({ status: 403 });
  });

  it('does not query new storage when the flag is absent', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    await enroll();
    expect(db.findOne).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
  it('does not backfill old handovers, frozen invoices or non-FixHome items', async () => {
    request.receivedAt = new Date('2025-12-31T00:00:00Z'); await enroll();
    expect(rows).toHaveLength(0);
    request.receivedAt = new Date(); frozen = true; await enroll(); expect(rows).toHaveLength(0);
    frozen = false; request.items[0].partSource = PartSource.EXTERNAL; await enroll(); expect(rows).toHaveLength(0);
  });
  it('fails inactive without a persisted activation', async () => {
    db.findOne.mockResolvedValue(null);
    await enroll(); expect(rows).toHaveLength(0);
    await expect(service.byOrder('order', tech)).rejects.toMatchObject({ status: 503 });
  });
  it('supports issued 3 / used 2 / due 1 without treating declaration as physical receipt', async () => {
    await enroll();
    await service.recordUsage(db, request, request.items[0], order, { usedQty: 2, expectedVersion: 0, idempotencyKey: 'usage-key-01' }, tech);
    const declared = await service.command('request', 'item', 'declare_return', body(), tech);
    expect(declared).toMatchObject({ issuedQty: 3, usedQty: 2, declaredQty: 1, managerAcceptedQty: 0, outstandingQty: 1, version: 2 });
    order.status = ServiceOrderStatus.COMPLETED; frozen = true;
    const accepted = await service.command('request', 'item', 'accept_return', body(1, 2, 'accept-key-01'), managerActor);
    expect(accepted).toMatchObject({ outstandingQty: 0, managerAcceptedQty: 1, version: 3 });
    expect(entries.at(-1)).toMatchObject({ kind: 'accept_return', actorUserId: managerActor.id, actorRole: Role.SERVICE_MANAGER, quantity: 1 });
    expect(entries.at(-1)?.occurredAt).toBeInstanceOf(Date);
    expect(order.status).toBe(ServiceOrderStatus.COMPLETED);
  });
  it('returns the original replay response and rejects same key with changed body', async () => {
    await enroll();
    const initial = await service.command('request', 'item', 'declare_return', body(2, 0), tech);
    await service.command('request', 'item', 'accept_return', body(1, 1, 'accept-key-01'), managerActor);
    expect(await service.command('request', 'item', 'declare_return', body(2, 0), tech)).toEqual(initial);
    expect(entries).toHaveLength(2);
    await expect(service.command('request', 'item', 'declare_return', body(1, 0), tech)).rejects.toMatchObject({ status: 409 });
  });
  it('replays old zero usage after usage increases without reversing billing or duplicating writes', async () => {
    request.status = PartRequestStatus.RECEIVED;
    const item = request.items[0];
    item.partCatalogId = 'catalog';
    await enroll();
    const audit = { logWithManager: vi.fn().mockResolvedValue(undefined) };
    const parts = Object.assign(Object.create(PartRequestsService.prototype), {
      dataSource: { transaction: async cb => cb(db) }, custodyService: service, auditLogService: audit,
    }) as PartRequestsService;
    vi.spyOn(parts as any, 'lockRequest').mockResolvedValue({ request, order });
    const zero = { usageStatus: PartUsageStatus.RETURNED, usedQty: 0, expectedVersion: 0, idempotencyKey: 'usage-zero-old' };
    await parts.updateItemUsage(request.id, item.id, zero, tech);
    await parts.updateItemUsage(request.id, item.id, {
      usageStatus: PartUsageStatus.USED, usedQty: 2, expectedVersion: 1, idempotencyKey: 'usage-two-new',
    }, tech);
    const state = structuredClone(rows[0].state);
    db.save.mockClear(); audit.logWithManager.mockClear();

    expect(await parts.updateItemUsage(request.id, item.id, zero, tech)).toMatchObject({ usageStatus: PartUsageStatus.USED });
    expect(rows[0].state).toEqual(state);
    expect(entries).toHaveLength(2);
    expect(db.save).not.toHaveBeenCalled();
    expect(audit.logWithManager).not.toHaveBeenCalled();
    const bill = () => usedPartQuantities([request], new Map([[item.id, rows[0].state.usedQty]]))(
      'quotation', { partSource: PartSource.FIXHOME, partCatalogId: item.partCatalogId, quantity: 3 },
    );
    expect(bill()).toBe(2);
    await expect(parts.updateItemUsage(request.id, item.id, { ...zero, usedQty: 1 }, tech)).rejects.toMatchObject({ status: 409 });
    expect(rows[0].state).toEqual(state);
    expect(entries).toHaveLength(2);

    await service.command(request.id, item.id, 'declare_return', body(1, 2, 'return-after-replay'), tech);
    const accepted = await service.command(request.id, item.id, 'accept_return', body(1, 3, 'accept-after-replay'), managerActor);
    expect(accepted).toMatchObject({ issuedQty: 3, usedQty: 2, managerAcceptedQty: 1, outstandingQty: 0, version: 4 });
    expect(item.quantity).toBe(3);
    expect(bill()).toBe(2);
  });
  it('keeps partial manager receipt outstanding and rejects undeclared or excessive receipt', async () => {
    await enroll();
    await expect(service.command('request', 'item', 'accept_return', body(1, 0), managerActor)).rejects.toMatchObject({ status: 409 });
    await service.command('request', 'item', 'declare_return', body(2, 0), tech);
    expect(await service.command('request', 'item', 'accept_return', body(1, 1, 'accept-key-01'), managerActor)).toMatchObject({ outstandingQty: 2 });
    await expect(service.command('request', 'item', 'accept_return', body(2, 2, 'accept-key-02'), managerActor)).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ id: 'other', role: Role.TECHNICIAN }, { id: 'customer', role: Role.CUSTOMER }, managerActor])('rejects declaration by non-owner %o', async actor => {
    await enroll();
    await expect(service.command('request', 'item', 'declare_return', body(1, 0), actor)).rejects.toMatchObject({ status: 403 });
  });
  it.each([tech, { id: 'customer', role: Role.CUSTOMER }])('rejects physical acceptance by %o', async actor => {
    await enroll();
    await expect(service.command('request', 'item', 'accept_return', body(1, 0), actor)).rejects.toMatchObject({ status: 403 });
  });
  it('restricts reads to original custodian or manager and rejects request/item mismatch', async () => {
    await enroll();
    expect(await service.byOrder('order', managerActor)).toHaveLength(1);
    expect(await service.byOrder('order', tech)).toHaveLength(1);
    await expect(service.byOrder('order', { id: 'other', role: Role.TECHNICIAN })).rejects.toMatchObject({ status: 403 });
    await expect(service.byOrder('order', { id: 'customer', role: Role.CUSTOMER })).rejects.toMatchObject({ status: 403 });
    rows[0].partRequestId = 'another-request';
    await expect(service.command('request', 'item', 'declare_return', body(1, 0), tech)).rejects.toMatchObject({ status: 404 });
  });
  it('freezes usage with the invoice and rejects stale versions', async () => {
    await enroll(); frozen = true;
    await expect(service.recordUsage(db, request, request.items[0], order, { usedQty: 2, expectedVersion: 0, idempotencyKey: 'usage-key-01' }, tech)).rejects.toMatchObject({ status: 409 });
    await expect(service.command('request', 'item', 'declare_return', body(1, 8), tech)).rejects.toMatchObject({ status: 409 });
  });
});

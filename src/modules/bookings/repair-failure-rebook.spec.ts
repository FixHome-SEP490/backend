import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { FindOperator } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Role, ServiceOrderStatus, BookingStatus, SupportCaseType } from '../../shared/enums';
import { CATALOG_V2_APPROVED_FIXED_TIERS as tiers } from '../../database/catalog-v2/catalog-v2-approved-price-tiers';

function fixture(count = 1, grouped = count > 1) {
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const addressId = randomUUID();
  const serviceId = randomUUID();
  const groupId = grouped ? randomUUID() : null;
  const sources = Array.from({ length: grouped ? 3 : count }, (_, i) => ({ id: randomUUID(), customerId: customer.id, serviceId, visitGroupId: groupId,
    status: i < count ? BookingStatus.CANCELLED : BookingStatus.MATCHED, addressId, quantity: 1, description: `Synthetic device ${i}`, deviceAttributesSnapshot: { acMounting: 'wall', acHorsepower: 'up_to_1_5' },
    catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01', laborPriceVnd: 1 } }, fixedUnitPriceSnapshot: 1, slot: 'morning', customerNote: 'Synthetic note',
  }));
  const rows: Record<string, any[]> = {
    Booking: sources,
    VisitGroup: grouped ? [{ id: groupId, customerId: customer.id }] : [],
    VisitGroupItem: grouped ? sources.map((b, i) => ({ groupId, bookingId: b.id, sequence: i + 1, outcome: i < count ? 'failed' : 'succeeded' })) : [],
    ServiceOrder: sources.map(b => ({ id: randomUUID(), bookingId: b.id, status: ServiceOrderStatus.CANCELLED })),
    Service: [{ id: serviceId, code: 'AC-02', name: 'Synthetic service', isActive: true, pricingMode: 'inspection_required' }],
    User: [{ id: customer.id }],
    Address: [{ id: addressId, userId: customer.id, line1: 'Synthetic address', lat: 10, lng: 106 }],
    RepairFailureRebook: [], RepairFailureRebookSource: [],
  };
  rows.SupportCase = rows.ServiceOrder.map(o => ({ id: randomUUID(), bookingId: o.bookingId, serviceOrderId: o.id, customerId: customer.id, technicianId: 'tech', createdByUserId: 'tech', caseType: SupportCaseType.MID_JOB_INTERRUPTION }));
  rows.AuditLog = rows.SupportCase.slice(0, count).map(c => ({ action: 'VISIT_DEVICE_REPAIR_FAILED', resourceType: 'service_order', resourceId: c.serviceOrderId, actorRole: Role.TECHNICIAN, actorUserId: 'tech',
    after: { version: 1, incidentId: c.id, request: { reason: 'other', note: null, parts: [], photoEvidenceIds: [] } } }));
  const variants = tiers.filter(t => t.serviceCode === 'AC-02').map(t => ({ id: randomUUID(), service_id: serviceId, variant_code: t.variantCode, fixed_labor_price_vnd: String(t.laborPriceVnd), included_scope: t.conditionVi, excluded_scope: null, is_active: true }));
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]) => value instanceof FindOperator ? value.type === 'in' ? value.value.includes(row[key]) : row[key] !== value.value : row[key] === value);
  const table = (entity: any) => rows[entity.name] ??= [];
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    find: vi.fn(async (entity, options) => table(entity).filter(row => matches(row, options?.where))),
    findOne: vi.fn(async (entity, options) => table(entity).find(row => matches(row, options?.where)) ?? null),
    findOneBy: vi.fn(async (entity, where) => table(entity).find(row => matches(row, where)) ?? null),
    create: (entity: any, value: any) => Object.assign(new entity(), value),
    save: vi.fn(async (entityOrValue, maybeValue) => {
      const value = maybeValue ?? entityOrValue;
      const entity = maybeValue ? entityOrValue : value.constructor;
      const saved = { id: randomUUID(), ...value }; table(entity).push(saved); return saved;
    }),
    insert: vi.fn(async (entity, value) => { for (const row of Array.isArray(value) ? value : [value]) table(entity).push({ id: randomUUID(), ...row }); }),
    update: vi.fn(async (entity, where, value) => { table(entity).filter(row => matches(row, typeof where === 'string' ? { id: where } : where)).forEach(row => Object.assign(row, value)); return { affected: 1 }; }),
    query: vi.fn(async (sql: string) => sql.includes('JOIN service_categories') ? [{ code: 'AC-02' }] : variants),
  };
  manager.getRepository = (entity: any) => ({
    create: (value: any) => manager.create(entity, value), save: (value: any) => manager.save(entity, value),
    find: (options: any) => manager.find(entity, options), findOneBy: (where: any) => manager.findOneBy(entity, where),
  });
  let serial = Promise.resolve();
  const dataSource = { manager, transaction: vi.fn((work: any) => {
    const run = serial.then(async () => {
      const before = structuredClone(rows);
      try { return await work(manager); } catch (error) { Object.keys(rows).forEach(key => delete rows[key]); Object.assign(rows, before); throw error; }
    });
    serial = run.then(() => undefined, () => undefined); return run;
  }) };
  const bookings = Object.assign(Object.create(BookingsService.prototype), { dataSource,
    userRepo: manager.getRepository(class User {}), serviceRepo: manager.getRepository(class Service {}), addressRepo: manager.getRepository(class Address {}),
    configService: { getInt: async (_: string, fallback: number) => fallback }, auditLogService: new AuditLogService({} as never),
  }) as BookingsService;
  const groups = Object.assign(Object.create(VisitGroupsService.prototype), { dataSource, bookingsService: bookings,
    groupRepo: manager.getRepository(class VisitGroup {}), itemRepo: manager.getRepository(class VisitGroupItem {}),
    config: { getString: async () => 'true' }, auditLogService: new AuditLogService({} as never),
  }) as VisitGroupsService;
  const createGroup = vi.fn((dto, actor, tx) => (groups.create as any)(dto, actor, tx));
  const dto = { idempotencyKey: 'synthetic-rebook-01', addressId, date: '2030-10-28', slot: 'afternoon',
    items: sources.slice(0, count).map(b => ({ sourceBookingId: b.id, sourceIncidentId: rows.SupportCase.find(c => c.bookingId === b.id).id })) };
  const confirm = (body: any = dto, actor: any = customer) => (bookings as any).confirmRepairFailureRebook(sources[0].id, body, actor, createGroup);
  return { rows, sources, dto, customer, confirm, manager, dataSource, createGroup, variants };
}

describe('final repair-failure confirmation', () => {
  it('rejects a noncustomer before any transaction or creation', async () => {
    const transaction = vi.fn();
    const service = Object.assign(Object.create(BookingsService.prototype), { dataSource: { transaction } }) as BookingsService;
    await expect((service as any).confirmRepairFailureRebook('source', {}, { id: 'admin', role: 'admin' }, vi.fn())).rejects.toThrow('Customer role required');
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])('creates %i failed sources as exactly one standalone booking or one group inside one transaction', async count => {
    const f = fixture(count, true);
    const before = structuredClone(f.sources);
    const result = await f.confirm();
    expect(result.targetKind).toBe(count === 1 ? 'booking' : 'visit_group');
    expect(result.items).toHaveLength(count);
    expect(f.rows.Booking).toHaveLength(3 + count);
    expect(f.rows.RepairFailureRebook).toHaveLength(1);
    expect(f.rows.RepairFailureRebookSource).toHaveLength(count);
    expect(f.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(f.createGroup).toHaveBeenCalledTimes(count === 1 ? 0 : 1);
    expect(f.rows.Booking.slice(0, 3)).toEqual(before);
    expect(f.rows.Booking.slice(3).every(b => b.fixedUnitPriceSnapshot === 199000 && b.slot === 'afternoon' && b.quantity === 1)).toBe(true);
    expect(f.rows.Booking.slice(3).every(b => count === 1 ? b.visitGroupId === null : b.visitGroupId === result.visitGroupId)).toBe(true);
    expect(f.rows.BookingInvitation ?? []).toHaveLength(0);
    expect(f.rows.Invoice ?? []).toHaveLength(0);
  });

  it('handles a solo failure and returns the identical result for concurrent double click/retry', async () => {
    const f = fixture();
    const results = await Promise.all([f.confirm(), f.confirm(), f.confirm()]);
    expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
    expect(f.rows.Booking).toHaveLength(2);
    expect(f.rows.RepairFailureRebookSource).toHaveLength(1);
  });

  it('fails closed if the original group lead cannot be locked', async () => {
    const f = fixture(2, true);
    const findOne = f.manager.findOne.getMockImplementation();
    f.manager.findOne.mockImplementation((entity: any, options: any) => entity.name === 'Booking' && options?.lock ? null : findOne(entity, options));
    await expect(f.confirm()).rejects.toThrow();
    expect(f.rows.RepairFailureRebook).toHaveLength(0);
    expect(f.rows.Booking).toHaveLength(3);
  });

  it.each(['foreign user', 'foreign incident', 'generic cancelled', 'different sibling group', 'inactive service', 'inactive variant', 'past slot', 'duplicate source'])('rejects %s without creating a target', async bad => {
    const f = fixture(2, true);
    const actor = { ...f.customer };
    if (bad === 'foreign user') actor.id = randomUUID();
    if (bad === 'foreign incident') f.dto.items[0].sourceIncidentId = randomUUID();
    if (bad === 'generic cancelled') f.rows.AuditLog = [];
    if (bad === 'different sibling group') f.sources[1].visitGroupId = randomUUID();
    if (bad === 'inactive service') f.rows.Service[0].isActive = false;
    if (bad === 'inactive variant') f.variants[0].is_active = false;
    if (bad === 'past slot') f.dto.date = '2020-01-01';
    if (bad === 'duplicate source') f.dto.items[1] = { ...f.dto.items[0] };
    await expect(f.confirm(f.dto, actor)).rejects.toThrow();
    expect(f.rows.Booking).toHaveLength(3);
    expect(f.rows.RepairFailureRebook).toHaveLength(0);
  });

  it('rejects changed payload under the same scoped key and another key consuming the same child', async () => {
    const f = fixture();
    await f.confirm();
    await expect(f.confirm({ ...f.dto, slot: 'evening' })).rejects.toThrow();
    await expect(f.confirm({ ...f.dto, idempotencyKey: 'another-rebook-02' })).rejects.toThrow();
    expect(f.rows.Booking).toHaveLength(2);
  });

  it.each(['RepairFailureRebook', 'RepairFailureRebookSource'])('rolls back all new group children if %s cannot persist', async name => {
    const f = fixture(2, true);
    const insert = f.manager.insert.getMockImplementation();
    const save = f.manager.save.getMockImplementation();
    f.manager.insert.mockImplementation(async (entity: any, value: any) => { if (entity.name === name) throw new Error('receipt failed'); return insert(entity, value); });
    f.manager.save.mockImplementation(async (entity: any, value: any) => { if (entity.name === name) throw new Error('receipt failed'); return save(entity, value); });
    await expect(f.confirm()).rejects.toThrow('receipt failed');
    expect(f.rows.Booking).toHaveLength(3);
    expect(f.rows.VisitGroup).toHaveLength(1);
    expect(f.rows.RepairFailureRebook).toHaveLength(0);
    expect(f.rows.RepairFailureRebookSource).toHaveLength(0);
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { VisitGroupsService } from './visit-groups.service';
import { VisitGroupMyPageQueryDto, VisitGroupAssignedPageQueryDto } from './visit-group-page.dto';
import { deriveVisitGroupStatus } from './visit-group-read';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { VisitGroupsController } from './visit-groups.controller';

const parent = {
  id: 'group-1',
  status: 'submitted',
  customerId: 'customer-b',
  addressId: 'PRIVATE_ADDRESS',
  bookingMode: 'scheduled',
  slot: 'afternoon',
  preferredStartAt: new Date('2030-10-22T06:00:00.000Z'),
  preferredEndAt: new Date('2030-10-22T11:00:00.000Z'),
  createdAt: new Date('2030-10-20T00:00:00.000Z'),
};

function child(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    itemId: `item-${sequence}`,
    groupId: parent.id,
    sequence,
    bookingId: `booking-${sequence}`,
    serviceId: `service-${sequence}`,
    deviceLabel: `Device ${sequence}`,
    outcome: null,
    bookingStatus: 'matched',
    serviceName: `Service ${sequence}`,
    orderId: `order-${sequence}`,
    orderCode: `SO-${sequence}`,
    orderStatus: 'accepted',
    hasActiveAssignment: true,
    ...overrides,
  };
}

function harness(groups: unknown[] = [parent], total = groups.length, rows: unknown[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, any> = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'skip', 'take']) {
    qb[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    });
  }
  qb.getManyAndCount = vi.fn(async () => [groups, total]);
  const groupRepo = { createQueryBuilder: vi.fn(() => qb) };
  const dataSource = { query: vi.fn(async () => rows) };
  const service = Object.assign(Object.create(VisitGroupsService.prototype), { groupRepo, dataSource }) as VisitGroupsService;
  return { service, groupRepo, dataSource, qb, calls };
}

describe('VisitGroupsService parent paging', () => {
  it('binds the requesting technician on the same active order join that projects the snapshot', async () => {
    const technicianId = "tech' OR true --";
    const h = harness([parent], 1, [child(1)]);
    await h.service.assignedPage(technicianId, {});
    const [sql, parameters] = h.dataSource.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(parameters).toEqual([[parent.id], technicianId]);
    expect(sql).not.toContain(technicianId);
    expect(sql).toContain('ta.service_order_id = so.id AND ta.is_active = true AND ta.technician_id = $2');
    expect(sql).toContain('CASE WHEN ta.id IS NOT NULL THEN vb.address_text_snapshot ELSE NULL END');
    expect(sql).toContain('JOIN bookings vb ON vb.id = vgi.booking_id');
    expect(sql).toContain('WHERE vgi.group_id = ANY($1::uuid[])');
  });

  it('never selects an inactive sibling address and strips all child address fields', async () => {
    const h = harness([parent], 1, [
      child(1, { outcome: 'failed', hasActiveAssignment: false, assignedAddressSnapshot: 'PRIVATE_FAILED' }),
      child(2, { outcome: 'interrupted', hasActiveAssignment: false, assignedAddressSnapshot: 'PRIVATE_INTERRUPTED' }),
      child(3, { assignedAddressSnapshot: 'SYNTHETIC_CURRENT' }),
    ]);
    const result = await h.service.assignedPage('current', {});
    expect(result.data[0].assignedAddressSummary).toBe('SYNTHETIC_CURRENT');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FAILED|PRIVATE_INTERRUPTED|assignedAddressSnapshot|hasActiveAssignment/);
  });

  it('fails closed for the address when assignment is released between parent and child reads', async () => {
    const h = harness([parent], 1, [child(1, { hasActiveAssignment: false, assignedAddressSnapshot: 'PRIVATE_STALE' })]);
    const result = await h.service.assignedPage('former', {});
    expect(result.data[0].assignedAddressSummary).toBeNull();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_STALE');
  });

  it('preserves each mixed child state and outcome without mutating source rows', async () => {
    const rows = [
      child(1, { outcome: 'succeeded', orderStatus: 'completed' }),
      child(2, { outcome: 'failed', orderStatus: 'cancelled', hasActiveAssignment: false }),
      child(3, { outcome: 'quote_declined', orderStatus: 'cancelled' }),
    ];
    const before = structuredClone(rows);
    const result = await harness([parent], 1, rows).service.assignedPage('current', {});
    expect(result.data[0].status).toBe('mixed');
    expect(result.data[0].items.map(({ orderStatus, outcome }) => ({ orderStatus, outcome })))
      .toEqual(rows.map(({ orderStatus, outcome }) => ({ orderStatus, outcome })));
    expect(rows).toEqual(before);
  });

  it('keeps customer detail ownership and does not add the assigned-page summary', async () => {
    const groupRepo = { findOneBy: vi.fn(async ({ id, customerId }) => id === parent.id && customerId === parent.customerId ? parent : null) };
    const itemRepo = { find: vi.fn(async () => []) };
    const service = Object.assign(Object.create(VisitGroupsService.prototype), { groupRepo, itemRepo }) as VisitGroupsService;
    await expect(service.detail(parent.id, { id: 'other-customer' })).rejects.toThrow();
    await expect(service.detail(parent.id, { id: 'former-technician' })).rejects.toThrow();
    await expect(service.detail('foreign-group', { id: parent.customerId })).rejects.toThrow();
    expect(groupRepo.findOneBy).toHaveBeenCalledWith({ id: 'foreign-group', customerId: parent.customerId });
    expect(itemRepo.find).not.toHaveBeenCalled();
    const result = await service.detail(parent.id, { id: parent.customerId });
    expect(result).not.toHaveProperty('assignedAddressSummary');
  });

  it('preserves the owner lead booking address before a child order exists', async () => {
    const booking = { id: 'booking-1', customerId: parent.customerId, visitGroupId: parent.id, addressTextSnapshot: 'SYNTHETIC_PRIVATE_DETAIL', status: 'submitted' };
    const service = Object.assign(Object.create(VisitGroupsService.prototype), {
      groupRepo: { findOneBy: async () => parent },
      itemRepo: { find: async () => [{ bookingId: booking.id, sequence: 1 }] },
      dataSource: { getRepository: () => ({ find: async () => [booking] }) },
    }) as VisitGroupsService;
    const result = await service.detail(parent.id, { id: parent.customerId });
    expect(result.leadBookingId).toBe(booking.id);
    expect(result.items[0].booking).toMatchObject({ id: booking.id, status: booking.status, addressTextSnapshot: booking.addressTextSnapshot });
    expect(result).not.toHaveProperty('assignedAddressSummary');
    expect(booking.addressTextSnapshot).toBe('SYNTHETIC_PRIVATE_DETAIL');
  });

  it('constrains detail booking reads to the owner and group even with an unrelated item reference', async () => {
    const find = vi.fn(async () => []);
    const service = Object.assign(Object.create(VisitGroupsService.prototype), {
      groupRepo: { findOneBy: async () => parent },
      itemRepo: { find: async () => [{ bookingId: 'foreign-booking', sequence: 1 }] },
      dataSource: { getRepository: () => ({ find }) },
    }) as VisitGroupsService;
    const result = await service.detail(parent.id, { id: parent.customerId });
    expect(find).toHaveBeenCalledWith({
      where: { id: expect.anything(), customerId: parent.customerId, visitGroupId: parent.id },
      relations: ['media'],
    });
    expect(result.items[0].booking).toBeNull();
  });
  it('returns one parent row with three ordered children and no address or technician-only data', async () => {
    const h = harness([parent], 21, [
      child(1), child(2, { orderStatus: 'en_route' }), child(3, { orderStatus: 'under_repair' }),
    ]);

    const result = await h.service.myPage('customer-a', { page: 2, pageSize: 10 });

    expect(result).toMatchObject({ total: 21, page: 2, pageSize: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 'group-1', status: 'under_repair', scheduledAt: parent.preferredStartAt });
    expect(result.data[0].items.map((item) => item.orderId)).toEqual(['order-1', 'order-2', 'order-3']);
    expect(result.data[0].items).toHaveLength(3);
    expect(JSON.stringify(result.data)).not.toMatch(/PRIVATE_ADDRESS|customerNote|technicianId|technicianPhone/i);
    expect(h.dataSource.query).toHaveBeenCalledTimes(1);
    expect(h.qb.skip).toHaveBeenCalledWith(10);
    expect(h.qb.take).toHaveBeenCalledWith(10);
  });

  it('scopes the parent query to the authenticated customer before pagination', async () => {
    const h = harness([], 0);

    await h.service.myPage('customer-a', { page: 1, pageSize: 10 });

    expect(h.qb.where).toHaveBeenCalledWith('vg.customerId = :customerId', { customerId: 'customer-a' });
    expect(h.dataSource.query).not.toHaveBeenCalled();
  });

  it('filters by derived status and binds search text before counting and paging parents', async () => {
    const h = harness([parent], 1, [child(1, { outcome: 'failed', orderStatus: 'cancelled' })]);
    const q = "x' OR 1=1 --";

    await h.service.myPage('customer-a', { page: 1, pageSize: 10, status: 'failed', q });

    const filters = h.calls.filter((call) => call.method === 'andWhere');
    expect(filters.some(({ args }) => String(args[0]).includes('CASE'))).toBe(true);
    expect(filters.some(({ args }) => String(args[0]).includes('ILIKE'))).toBe(true);
    expect(JSON.stringify(filters.map(({ args }) => args[0]))).not.toContain(q);
    expect(JSON.stringify(filters.map(({ args }) => args[1]))).toContain(`%${q}%`);
    expect(h.calls.findIndex(({ method }) => method === 'andWhere')).toBeLessThan(h.calls.findIndex(({ method }) => method === 'skip'));
    expect(h.calls.findIndex(({ method }) => method === 'skip')).toBeLessThan(h.calls.findIndex(({ method }) => method === 'take'));
  });

  it('returns no group for a released or reassigned technician and exempts failed terminal children from active assignment', async () => {
    const h = harness([], 0);

    const result = await h.service.assignedPage('tech-former', { page: 1, pageSize: 20, tab: 'all' });

    expect(result.data).toEqual([]);
    const parentFilters = h.calls.filter(({ method }) => method === 'andWhere').map(({ args }) => args);
    const activeAssignmentSql = parentFilters.map(([sql]) => String(sql)).join('\n');
    expect(activeAssignmentSql).toContain('ta.technician_id = :technicianId');
    expect(activeAssignmentSql).toContain('ta.is_active = true');
    expect(activeAssignmentSql).toContain("vgi.outcome IS DISTINCT FROM 'failed'");
    expect(activeAssignmentSql).toContain('NOT EXISTS');
    expect(h.calls.some(({ args }) => JSON.stringify(args).includes('tech-former'))).toBe(true);
    expect(h.dataSource.query).not.toHaveBeenCalled();
  });

  it('shows an address snapshot only for a currently assigned technician, never in customer listing', async () => {
    const address = '12 Đường kiểm thử, Quận 1';
    const h = harness([parent], 1, [
      child(1, { assignedAddressSnapshot: address, hasActiveAssignment: true }),
      child(2, { assignedAddressSnapshot: null, hasActiveAssignment: false, outcome: 'failed' }),
    ]);
    const assigned = await h.service.assignedPage('tech-current', { page: 1, pageSize: 20 });
    expect(assigned.data[0]).toMatchObject({ assignedAddressSummary: address });
    expect(assigned.data[0].items[0]).not.toHaveProperty('assignedAddressSnapshot');
    const recordedQueries = h.dataSource.query.mock.calls as unknown as Array<[string, unknown[]]>;
    const sql = recordedQueries[0][0];
    expect(sql).toContain('ta.id IS NOT NULL');
    expect(sql).toContain('vb.address_text_snapshot');
    expect(recordedQueries[0][1]).toContain('tech-current');

    const publicPage = await h.service.myPage('customer-a', { page: 1, pageSize: 20 });
    expect(publicPage.data[0]).not.toHaveProperty('assignedAddressSummary');
    expect(JSON.stringify(publicPage.data)).not.toContain(address);
    expect(recordedQueries[1][0]).not.toContain('vb.address_text_snapshot');
  });

  it('maps the technician in-progress tab to accepted, en-route, and under-repair child order states', async () => {
    const h = harness([parent], 1, [child(1)]);

    await h.service.assignedPage('tech-current', { page: 1, pageSize: 20, tab: 'in_progress' });

    const tabFilter = h.calls.find(({ method, args }) => method === 'andWhere' && String(args[0]).includes("IN ('accepted', 'en_route', 'under_repair')"));
    expect(tabFilter).toBeDefined();
    expect(h.dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('keeps terminal technician tabs aligned with the derived parent status', async () => {
    const h = harness([parent], 1, [child(1, { outcome: 'failed', orderStatus: 'cancelled' })]);

    await h.service.assignedPage('tech-current', { page: 1, pageSize: 20, tab: 'failed' });

    expect(h.calls.some(({ method, args }) => method === 'andWhere' && String(args[0]).includes('CASE') && JSON.stringify(args[1]).includes('failed'))).toBe(true);
  });

  it('derives progress and terminal outcomes from child orders without turning failure into cancellation', () => {
    expect(deriveVisitGroupStatus([child(1), child(2, { orderStatus: 'under_repair' })])).toBe('under_repair');
    expect(deriveVisitGroupStatus([child(1, { outcome: 'failed', orderStatus: 'cancelled' })])).toBe('failed');
    expect(deriveVisitGroupStatus([child(1, { outcome: 'quote_declined', orderStatus: 'cancelled' })])).toBe('quote_declined');
    expect(deriveVisitGroupStatus([child(1, { bookingStatus: 'cancelled', orderStatus: null, orderId: null })])).toBe('cancelled');
    expect(deriveVisitGroupStatus([child(1, { outcome: 'succeeded', orderStatus: 'completed' })])).toBe('completed');
  });

  it('keeps an interrupted child visible with two continuing devices', async () => {
    const h = harness([parent], 1, [
      child(1, { outcome: 'interrupted', orderStatus: 'cancelled', bookingStatus: 'cancelled', hasActiveAssignment: false }),
      child(2, { orderStatus: 'under_repair' }), child(3, { orderStatus: 'under_repair' }),
    ]);
    const page = await h.service.assignedPage('tech-current', { tab: 'in_progress' });
    expect(page.data[0].status).toBe('under_repair');
    expect(page.data[0].items).toHaveLength(3);
    expect(page.data[0].items[0].outcome).toBe('interrupted');
    const filters = h.calls.filter(call => call.method === 'andWhere').map(call => String(call.args[0]));
    expect(filters.join('\n')).toContain("vgi.outcome IS DISTINCT FROM 'interrupted'");
  });

  it('keeps the visit listed when the customer refused one device quote and the other is still being repaired', async () => {
    const h = harness([parent], 1, [
      child(1, { orderStatus: 'under_repair' }),
      child(2, { outcome: 'quote_declined', orderStatus: 'cancelled', bookingStatus: 'cancelled', hasActiveAssignment: false }),
    ]);
    const page = await h.service.assignedPage('tech-current', { tab: 'in_progress' });
    expect(page.data[0].status).toBe('under_repair');
    expect(page.data[0].items[1].outcome).toBe('quote_declined');
    const filters = h.calls.filter(call => call.method === 'andWhere').map(call => String(call.args[0]));
    expect(filters.join('\n')).toContain("vgi.outcome IS DISTINCT FROM 'quote_declined'");
  });
});

describe('Visit group page query validation', () => {
  it.each([undefined, Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER, Role.TECHNICIAN])('enforces assigned-page role metadata for %s', (role) => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => VisitGroupsController.prototype.assignedPage,
      getClass: () => VisitGroupsController,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: 'actor', role } : undefined }) }),
    } as unknown as ExecutionContext;
    if (role === Role.TECHNICIAN) expect(guard.canActivate(context)).toBe(true);
    else expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('uses authenticated identity even when an untrusted query carries another technician ID', async () => {
    const assignedPage = vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20 }));
    const controller = new VisitGroupsController({ assignedPage } as unknown as VisitGroupsService, {} as never);
    const query = Object.assign(new VisitGroupAssignedPageQueryDto(), { technicianId: 'victim' });
    await controller.assignedPage({ user: { id: 'authenticated', role: Role.TECHNICIAN } }, query);
    expect(assignedPage).toHaveBeenCalledWith('authenticated', query);
  });
  it('rejects invalid page bounds, status, tab, and oversized search', () => {
    const customerQuery = plainToInstance(VisitGroupMyPageQueryDto, {
      page: '0', pageSize: '101', status: 'submitted OR 1=1', q: 'q'.repeat(101),
    });
    expect(validateSync(customerQuery).map((error) => error.property)).toEqual(expect.arrayContaining(['page', 'pageSize', 'status', 'q']));

    const technicianQuery = plainToInstance(VisitGroupAssignedPageQueryDto, { tab: 'released-history' });
    expect(validateSync(technicianQuery).map((error) => error.property)).toContain('tab');
  });
});

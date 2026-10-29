import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { VisitGroupsService } from './visit-groups.service';
import { VisitGroupMyPageQueryDto, VisitGroupAssignedPageQueryDto } from './visit-group-page.dto';
import { deriveVisitGroupStatus } from './visit-group-read';

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
});

describe('Visit group page query validation', () => {
  it('rejects invalid page bounds, status, tab, and oversized search', () => {
    const customerQuery = plainToInstance(VisitGroupMyPageQueryDto, {
      page: '0', pageSize: '101', status: 'submitted OR 1=1', q: 'q'.repeat(101),
    });
    expect(validateSync(customerQuery).map((error) => error.property)).toEqual(expect.arrayContaining(['page', 'pageSize', 'status', 'q']));

    const technicianQuery = plainToInstance(VisitGroupAssignedPageQueryDto, { tab: 'released-history' });
    expect(validateSync(technicianQuery).map((error) => error.property)).toContain('tab');
  });
});

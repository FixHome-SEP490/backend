import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { Role, ServiceOrderStatus } from '../../shared/enums';
import { MyOrdersQueryDto } from './dto/order-list-query.dto';
import { ServiceOrdersController } from './service-orders.controller';
import { ServiceOrdersService } from './service-orders.service';

function harness() {
  const userId = randomUUID();
  const orders = [ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.CANCELLED].map(status => ({
    id: randomUUID(), bookingId: randomUUID(), code: `SYNTHETIC-${status}`, status, createdAt: new Date(),
    customerPhone: 'PRIVATE_PHONE', addressSummary: 'PRIVATE_ADDRESS', destination: { lat: 10, lng: 106 },
    grandTotal: 199000, customerNote: 'PRIVATE_NOTE',
  }));
  const qb: Record<string, any> = {};
  for (const method of ['where', 'andWhere', 'innerJoin', 'leftJoin', 'orderBy', 'addOrderBy', 'skip', 'take']) qb[method] = vi.fn(() => qb);
  qb.getManyAndCount = vi.fn(async () => [orders, orders.length]);
  const manager = { findOne: vi.fn(async (_entity, { where }) => ({ id: randomUUID(), ...where, unassignReason: 'Synthetic withdrawal' })),
    findOneBy: vi.fn(async () => null) };
  const sweep = vi.fn(async () => undefined);
  const full = vi.fn(async order => order);
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    orderRepo: { createQueryBuilder: vi.fn(() => qb) }, dataSource: { manager }, cancelOverdueOrders: sweep, presentOrder: full,
  }) as ServiceOrdersService;
  return { userId, orders, qb, manager, sweep, full, service };
}

describe('former technician history opt-in', () => {
  it('validates the exact history enum; boolean and arbitrary values cannot enable it', () => {
    expect(validateSync(plainToInstance(MyOrdersQueryDto, { history: 'withdrawn' }), { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    for (const history of [true, 'true', 'all', '', ['withdrawn']]) {
      expect(validateSync(plainToInstance(MyOrdersQueryDto, { history }), { whitelist: true, forbidNonWhitelisted: true }).length).toBeGreaterThan(0);
    }
  });

  it('passes the validated history query through the existing guarded controller', async () => {
    const service = { findMyOrders: vi.fn(async () => ({ data: [], total: 0 })) };
    await new ServiceOrdersController(service as never).findMy({ user: { id: 'actor', role: Role.TECHNICIAN } },
      plainToInstance(MyOrdersQueryDto, { history: 'withdrawn', page: '2', pageSize: '5' }));
    expect(service.findMyOrders).toHaveBeenCalledWith('actor', Role.TECHNICIAN, expect.objectContaining({ history: 'withdrawn', page: 2, limit: 5 }));
  });

  it('returns only historical allowlisted summaries without changing nonterminal status or running a sweep', async () => {
    const h = harness(); const before = structuredClone(h.orders);
    const result = await h.service.findMyOrders(h.userId, Role.TECHNICIAN, { history: 'withdrawn' } as never);
    expect(result.total).toBe(3);
    expect(result.data.map(row => row.status)).toEqual(h.orders.map(row => row.status));
    for (const row of result.data) {
      expect(Object.keys(row).sort()).toEqual(['id', 'code', 'status', 'createdAt', 'completedAt', 'cancelledAt', 'historical'].sort());
      expect(row).toHaveProperty('historical', true);
    }
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|bookingId|destination|grandTotal|customerNote/);
    expect(h.orders).toEqual(before);
    expect(h.full).not.toHaveBeenCalled(); expect(h.sweep).not.toHaveBeenCalled();
  });

  it('scopes and deduplicates own inactive assignments before stable paging, including group children', async () => {
    const h = harness();
    await h.service.findMyOrders(h.userId, Role.TECHNICIAN, { history: 'withdrawn', page: 2, limit: 2, search: 'SYNTHETIC' } as never);
    const conditions = [...h.qb.where.mock.calls, ...h.qb.andWhere.mock.calls];
    const sql = conditions.map(([text]) => text).join(' ');
    expect(sql).toContain('EXISTS'); expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ta.is_active = false'); expect(sql).toContain('ta.is_active = true');
    expect(sql).toContain('ta.technician_id = :userId');
    expect(conditions.some(([, params]) => params?.userId === h.userId)).toBe(true);
    expect(sql).not.toMatch(/visit_group_items|o.status|full_name|customer_id/);
    expect(h.qb.innerJoin).not.toHaveBeenCalled(); expect(h.qb.leftJoin).not.toHaveBeenCalled();
    expect(h.qb.orderBy).toHaveBeenCalledWith('o.createdAt', 'DESC');
    expect(h.qb.addOrderBy).toHaveBeenCalledWith('o.id', 'DESC');
    expect(h.qb.skip).toHaveBeenCalledWith(2); expect(h.qb.take).toHaveBeenCalledWith(2);
    for (const [, options] of h.manager.findOne.mock.calls) expect(options.where).toMatchObject({ technicianId: h.userId, isActive: false });
  });

  it.each([Role.CUSTOMER, Role.ADMIN, Role.SERVICE_MANAGER, 'unknown'])('denies history to %s before reads or sweeps', async role => {
    const h = harness();
    await expect(h.service.findMyOrders(h.userId, role, { history: 'withdrawn' } as never)).rejects.toThrow();
    expect(h.qb.getManyAndCount).not.toHaveBeenCalled(); expect(h.sweep).not.toHaveBeenCalled();
  });

  it.each([{ history: 'all' }, { history: true }, { history: 'withdrawn', status: 'cancelled' },
    { history: 'withdrawn', statuses: ['cancelled'] }, { history: 'withdrawn', stage: 'completed' },
    { history: 'withdrawn', excludeVisitGroups: true }])('rejects incompatible direct-service options %j', async options => {
    const h = harness();
    await expect(h.service.findMyOrders(h.userId, Role.TECHNICIAN, options as never)).rejects.toThrow();
    expect(h.sweep).not.toHaveBeenCalled();
  });
});

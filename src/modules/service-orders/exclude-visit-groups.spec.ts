import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { Role } from '../../shared/enums';
import { MyOrderListQueryDto } from './dto/order-list-query.dto';

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, any> = {};
  for (const method of ['where', 'andWhere', 'orWhere', 'leftJoin', 'leftJoinAndSelect', 'innerJoin', 'orderBy', 'addOrderBy', 'skip', 'take']) {
    qb[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    });
  }
  qb.getManyAndCount = vi.fn(async () => [[], 0]);
  const orderRepo = { createQueryBuilder: vi.fn(() => qb) };
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    orderRepo,
    cancelOverdueOrders: vi.fn(async () => undefined),
    dataSource: { manager: {} },
  }) as ServiceOrdersService;
  return { service, qb, calls };
}

describe('service order list group exclusion', () => {
  it.each([Role.CUSTOMER, Role.TECHNICIAN])('filters grouped orders before paging for %s only when opted in', async (role) => {
    const h = harness();

    await h.service.findMyOrders('actor-1', role, { page: 1, limit: 20, excludeVisitGroups: true } as never);

    const filter = h.calls.find(({ method, args }) => method === 'andWhere' && String(args[0]).includes('visit_group_items'));
    expect(filter?.args[0]).toContain('NOT EXISTS');
    expect(h.calls.findIndex(({ method }) => method === 'andWhere')).toBeLessThan(h.calls.findIndex(({ method }) => method === 'skip'));
    expect(h.qb.skip).toHaveBeenCalledWith(0);
    expect(h.qb.take).toHaveBeenCalledWith(20);
  });

  it('filters grouped orders from repair history before its page and count when opted in', async () => {
    const h = harness();

    await h.service.getRepairHistory('customer-1', Role.CUSTOMER, { page: 1, limit: 10, excludeVisitGroups: true } as never);

    const filter = h.calls.find(({ method, args }) => method === 'andWhere' && String(args[0]).includes('visit_group_items'));
    expect(filter?.args[0]).toContain('NOT EXISTS');
    expect(h.calls.findIndex(({ method }) => method === 'andWhere')).toBeLessThan(h.calls.findIndex(({ method }) => method === 'skip'));
  });

  it.each([{}, { excludeVisitGroups: false }])('keeps repair history unchanged for $excludeVisitGroups', async (options) => {
    const h = harness();

    await h.service.getRepairHistory('customer-1', Role.CUSTOMER, options as never);

    expect(h.calls.some(({ args }) => String(args[0]).includes('visit_group_items'))).toBe(false);
  });

  it.each([{}, { excludeVisitGroups: false }])('keeps legacy order lists unchanged for $excludeVisitGroups', async (options) => {
    const h = harness();

    await h.service.findMyOrders('customer-1', Role.CUSTOMER, options as never);

    expect(h.calls.some(({ args }) => String(args[0]).includes('visit_group_items'))).toBe(false);
  });

  it('accepts only boolean strings for the opt-in flag', () => {
    const valid = plainToInstance(MyOrderListQueryDto, { excludeVisitGroups: 'false' });
    expect(valid.excludeVisitGroups).toBe(false);
    expect(validateSync(valid)).toHaveLength(0);

    const invalid = plainToInstance(MyOrderListQueryDto, { excludeVisitGroups: '1' });
    expect(validateSync(invalid).map((error) => error.property)).toContain('excludeVisitGroups');
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { MyBookingListQueryDto } from './dto/booking-list-query.dto';

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, any> = {};
  for (const method of ['where', 'andWhere', 'orWhere', 'leftJoin', 'leftJoinAndSelect', 'innerJoin', 'addSelect', 'orderBy', 'addOrderBy', 'skip', 'take']) {
    qb[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    });
  }
  qb.getManyAndCount = vi.fn(async () => [[], 0]);
  const bookingRepo = { createQueryBuilder: vi.fn(() => qb) };
  const service = Object.assign(Object.create(BookingsService.prototype), {
    bookingRepo,
    closeOverdueBookings: vi.fn(async () => undefined),
  }) as BookingsService;
  return { service, qb, calls };
}

describe('customer booking list group exclusion', () => {
  it('filters grouped child bookings in SQL before page and total are calculated when opted in', async () => {
    const h = harness();

    const result = await h.service.findMyBookings('customer-1', { page: 2, limit: 10, excludeVisitGroups: true } as never);

    expect(result.total).toBe(0);
    const filter = h.calls.find(({ method, args }) => method === 'andWhere' && String(args[0]).includes('visit_group_items'));
    expect(filter?.args[0]).toContain('NOT EXISTS');
    expect(h.calls.findIndex(({ method }) => method === 'andWhere')).toBeLessThan(h.calls.findIndex(({ method }) => method === 'skip'));
    expect(h.qb.skip).toHaveBeenCalledWith(10);
    expect(h.qb.take).toHaveBeenCalledWith(10);
  });

  it.each([{}, { excludeVisitGroups: false }])('leaves the legacy query unchanged for $excludeVisitGroups', async (options) => {
    const h = harness();

    await h.service.findMyBookings('customer-1', { page: 1, limit: 20, ...options } as never);

    expect(h.calls.some(({ args }) => String(args[0]).includes('visit_group_items'))).toBe(false);
  });

  it('accepts only boolean strings for the opt-in flag', () => {
    const valid = plainToInstance(MyBookingListQueryDto, { excludeVisitGroups: 'true' });
    expect(valid.excludeVisitGroups).toBe(true);
    expect(validateSync(valid)).toHaveLength(0);

    const invalid = plainToInstance(MyBookingListQueryDto, { excludeVisitGroups: 'yes' });
    expect(validateSync(invalid).map((error) => error.property)).toContain('excludeVisitGroups');
  });

  it('withoutOrder leaves out bookings that reached an order before page and total (a cancelled order is listed once)', async () => {
    const h = harness();

    await h.service.findMyBookings('customer-1', { page: 1, limit: 10, statuses: ['cancelled', 'closed'], withoutOrder: true } as never);

    const filter = h.calls.find(({ method, args }) => method === 'andWhere' && String(args[0]).includes('service_orders'));
    expect(filter?.args[0]).toBe('NOT EXISTS (SELECT 1 FROM service_orders wo WHERE wo.booking_id = b.id)');
    expect(h.calls.indexOf(filter!)).toBeLessThan(h.calls.findIndex(({ method }) => method === 'skip'));
    const valid = plainToInstance(MyBookingListQueryDto, { withoutOrder: 'true' });
    expect(valid.withoutOrder).toBe(true);
    expect(validateSync(valid)).toHaveLength(0);
    expect(validateSync(plainToInstance(MyBookingListQueryDto, { withoutOrder: '1' })).map((e) => e.property)).toContain('withoutOrder');
  });

  it('keeps the old result without withoutOrder, puts waiting requests first, newest first, id breaking ties', async () => {
    const h = harness();

    await h.service.findMyBookings('customer-1', { page: 1, limit: 10 } as never);

    expect(h.calls.some(({ args }) => String(args[0]).includes('service_orders wo'))).toBe(false);
    expect(h.qb.addSelect).toHaveBeenCalledWith("CASE WHEN b.status IN ('submitted', 'matching', 'closed') THEN 0 ELSE 1 END", 'active_rank');
    expect(h.qb.orderBy).toHaveBeenLastCalledWith('active_rank', 'ASC');
    expect(h.qb.addOrderBy).toHaveBeenCalledWith('b.createdAt', 'DESC');
    expect(h.qb.addOrderBy).toHaveBeenCalledWith('b.id', 'DESC');
  });
});

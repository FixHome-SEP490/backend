import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { andWhereTextMatches } from './list-search';
import { OrderListQueryDto } from '../../modules/service-orders/dto/order-list-query.dto';
import { BookingListQueryDto } from '../../modules/bookings/dto/booking-list-query.dto';

describe('list search (PO 12/10/2026: tables page on the server, so search must too)', () => {
  const builder = () => ({ andWhere: vi.fn() });

  it('matches each column without case or Vietnamese accents', () => {
    const qb = builder();
    andWhereTextMatches(qb as never, ['o.code', 'sb.service_name_snapshot'], '  Điều HÒA ');
    const [sql, params] = qb.andWhere.mock.calls[0];
    expect(sql).toContain("translate(lower(COALESCE(o.code, '')), :vnFrom, :vnTo) LIKE :folded");
    expect(sql).toContain(' OR ');
    expect(params.folded).toBe('%dieu hoa%');
  });

  it('treats % and _ typed by the user as plain characters', () => {
    const qb = builder();
    andWhereTextMatches(qb as never, ['o.code'], '50%_off');
    expect(qb.andWhere.mock.calls[0][1].folded).toBe('%50\\%\\_off%');
  });

  it('adds nothing for an empty search', () => {
    const qb = builder();
    andWhereTextMatches(qb as never, ['o.code'], '   ');
    andWhereTextMatches(qb as never, ['o.code'], undefined);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('reads comma-separated states and refuses unknown ones', async () => {
    const ok = plainToInstance(OrderListQueryDto, { statuses: 'accepted, en_route' });
    expect(await validate(ok)).toEqual([]);
    expect(ok.statuses).toEqual(['accepted', 'en_route']);
    const bad = plainToInstance(OrderListQueryDto, { statuses: 'accepted,flying' });
    expect((await validate(bad)).map((e) => e.property)).toContain('statuses');
  });

  it('reads overdue as a boolean and sort as one of two orders', async () => {
    const dto = plainToInstance(BookingListQueryDto, { overdue: 'true', sort: 'appointment', statuses: 'matching,closed' });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ overdue: true, sort: 'appointment', statuses: ['matching', 'closed'] });
    expect((await validate(plainToInstance(BookingListQueryDto, { sort: 'random' }))).map((e) => e.property)).toContain('sort');
    expect((await validate(plainToInstance(BookingListQueryDto, { overdue: 'maybe' }))).map((e) => e.property)).toContain('overdue');
  });
});

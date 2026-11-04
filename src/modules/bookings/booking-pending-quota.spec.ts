import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { InvitationsService } from './invitations.service';
import { Booking } from './entities/booking.entity';
import { BookingStatus, Role } from '../../shared/enums';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { technicianEligibility } from './technician-eligibility';
import { checkPendingVisitQuota } from './pending-visit-quota';

vi.mock('./technician-eligibility', () => ({ technicianEligibility: vi.fn(async () => ({ eligible: true })) }));

function fixture() {
  const customer = { id: randomUUID(), role: Role.CUSTOMER };
  const rows: any[] = [];
  const groups: any[] = [];
  let tail = Promise.resolve();
  const events: string[] = [];
  const add = (status = BookingStatus.SUBMITTED, groupId: string | null = null, end = new Date('2030-12-01')) => {
    const row = { id: randomUUID(), customerId: customer.id, status, visitGroupId: groupId, preferredEndAt: end };
    rows.push(row);
    return row;
  };
  const transaction = async (work: (manager: any) => Promise<any>) => {
    let release: (() => void) | undefined;
    const manager: any = {
      queryRunner: { isTransactionActive: true },
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes('FOR UPDATE') && sql.includes('users')) {
          if (release) return [{ id: customer.id }];
          const prior = tail;
          tail = new Promise<void>(resolve => { release = resolve; });
          await prior;
          events.push('customer-lock');
          return [{ id: customer.id }];
        }
        if (sql.includes('COUNT(DISTINCT')) {
          events.push('count');
          // Persistence double, NOT PostgreSQL execution/lock evidence. Check the emitted SQL
          // contract too, so removing expiry/status/customer/group filters fails these tests.
          const query = sql.replace(/\s+/g, ' ').trim();
          expect(query).toContain('COUNT(DISTINCT COALESCE(b.visit_group_id, b.id))::int AS pending');
          expect(query).toContain('b.customer_id = $1');
          expect(query).toContain("b.status IN ('submitted', 'matching') AND b.preferred_end_at > now()");
          expect(query).toContain('($2::uuid IS NULL OR COALESCE(b.visit_group_id, b.id) <> $2::uuid)');
          const pending = new Set(rows.filter(b => b.customerId === params[0]
            && ['submitted', 'matching'].includes(b.status) && b.preferredEndAt > new Date()
            && (!params[1] || (b.visitGroupId ?? b.id) !== params[1])).map(b => b.visitGroupId ?? b.id)).size;
          return [{ pending }];
        }
        if (sql.includes('JOIN service_categories')) return [{ id: 'service' }];
        return [];
      },
      findOne: async (entity: any, options: any) => {
        events.push(`${entity.name}-lock`);
        if (entity.name === 'User') return { id: customer.id };
        if (entity === Booking) return rows.find(row => row.id === options.where.id && (!options.where.customerId || row.customerId === options.where.customerId)) ?? null;
        return null;
      },
      findOneBy: async (entity: any, where: any) => entity.name === 'VisitGroup'
        ? groups.find(g => g.customerId === where.customerId && g.idempotencyKey === where.idempotencyKey) ?? null : null,
      find: async (entity: any) => entity === Booking ? rows.filter(row => row.visitGroupId) : [],
      create: (_entity: any, value: any) => ({ id: randomUUID(), ...value }),
      save: async (value: any) => {
        if (Array.isArray(value)) return value;
        if ('idempotencyKey' in value) groups.push(value);
        return value;
      },
      insert: async () => {}, update: async () => {},
      createQueryBuilder: () => ({ update() { return this; }, set() { return this; }, where() { return this; }, execute: async () => ({ affected: 0 }) }),
      getRepository: (entity: any) => entity === Booking ? {
        create: (value: any) => value,
        save: async (value: any) => {
          events.push('insert');
          const row = add(value.status, value.visitGroupId, value.preferredEndAt);
          Object.assign(row, value);
          return row;
        },
      } : {},
    };
    try { return await work(manager); } finally { release?.(); }
  };
  const source: any = { transaction, query: async () => [] };
  const bookings = Object.assign(Object.create(BookingsService.prototype), {
    userRepo: { findOneBy: async () => ({ id: customer.id }) },
    serviceRepo: { findOneBy: async () => ({ id: 'service', code: 'LEGACY', isActive: true, name: 'Synthetic', pricingMode: 'fixed_price', fixedPrice: 100000 }) },
    addressRepo: { findOneBy: async () => ({ line1: 'Synthetic', lat: 10, lng: 106 }) },
    configService: { getInt: async (_key: string, fallback: number) => fallback },
    dataSource: source, auditLogService: { log: async () => {}, logWithManager: async () => {} },
  }) as BookingsService;
  const invitations = new InvitationsService({} as never, {} as never, source,
    { getInt: async () => 30 } as never, { logWithManager: async () => {} } as never, {} as never);
  vi.spyOn(invitations as any, 'activateNext').mockResolvedValue(undefined);
  const visits = new VisitGroupsService(source, { findOneBy: async (where: any) => groups.find(g => g.idempotencyKey === where.idempotencyKey) ?? null } as never, {} as never, bookings,
    { getString: async () => 'true' } as never, {} as never, { logWithManager: async () => {} } as never, invitations, {} as never);
  vi.spyOn(visits, 'detail').mockImplementation(async (id: string) => ({ id }) as never);
  const dto = { serviceId: 'service', addressId: 'address', mode: 'scheduled' as const, date: '2030-11-10', slot: 'morning' as const };
  const create = () => bookings.create(dto, customer);
  return { customer, rows, events, add, transaction, bookings, invitations, visits, dto, create };
}

const quotaError = { response: expect.objectContaining({ code: 'PENDING_VISIT_LIMIT_REACHED' }), status: 409 };
beforeEach(() => { vi.mocked(technicianEligibility).mockClear(); });

describe('pending logical visit quota (Node 20 persistence double, PostgreSQL NOT VERIFIED)', () => {
  it.each([undefined, null, '11111111-1111-4111-8111-111111111111'])(
    'binds an explicit SQL null or logical visit id (%s)', async logicalVisitId => {
      const query = vi.fn(async () => [{ pending: 0 }]);
      await expect(checkPendingVisitQuota({ query } as never, 'customer', logicalVisitId)).resolves.toBe(true);
      expect(query).toHaveBeenCalledWith(expect.any(String), ['customer', logicalVisitId ?? null]);
    });

  it('allows two independent requests and rejects the third without insertion', async () => {
    const h = fixture();
    try {
      await h.create(); await h.create();
      await expect(h.create()).rejects.toMatchObject(quotaError);
      expect(h.rows).toHaveLength(2);
      expect(h.events.indexOf('customer-lock')).toBeLessThan(h.events.indexOf('count'));
      expect(h.events.indexOf('count')).toBeLessThan(h.events.indexOf('insert'));
    } finally { vi.clearAllMocks(); }
  });

  it('counts five pending children as one group, even with mixed accepted/closed children', async () => {
    const h = fixture();
    try {
      const group = randomUUID();
      for (let i = 0; i < 5; i++) h.add(BookingStatus.MATCHING, group);
      h.add(BookingStatus.MATCHED, group); h.add(BookingStatus.CLOSED, group);
      await h.create();
      await expect(h.create()).rejects.toMatchObject(quotaError);
    } finally { vi.clearAllMocks(); }
  });

  it('excludes expired pending, accepted, closed and cancelled visits', async () => {
    const h = fixture();
    try {
      h.add(BookingStatus.SUBMITTED, null, new Date('2020-01-01'));
      h.add(BookingStatus.MATCHING, null, new Date('2020-01-01'));
      for (const status of [BookingStatus.MATCHED, BookingStatus.CLOSED, BookingStatus.CANCELLED]) h.add(status);
      await h.create(); await h.create();
      await expect(h.create()).rejects.toMatchObject(quotaError);
    } finally { vi.clearAllMocks(); }
  });

  it('does not exempt solo rebook creation with an external manager', async () => {
    const h = fixture();
    try {
      h.add(); h.add();
      await expect(h.transaction(manager => h.bookings.create(h.dto, h.customer, { manager, visitGroupId: null }))).rejects.toMatchObject(quotaError);
      expect(h.rows).toHaveLength(2);
    } finally { vi.clearAllMocks(); }
  });

  it.each([false, true])('rejects closed shortlist reentry (group=%s) before invitations or state changes', async asVisit => {
    const h = fixture();
    try {
      h.add(); h.add();
      const old = h.add(BookingStatus.CLOSED, asVisit ? randomUUID() : null);
      await expect(h.invitations.createShortlist(old.id, ['tech'], h.customer, { asVisit })).rejects.toMatchObject(quotaError);
      expect(old.status).toBe(BookingStatus.CLOSED);
      expect(h.events.indexOf('customer-lock')).toBeLessThan(h.events.indexOf('Booking-lock'));
      expect(technicianEligibility).not.toHaveBeenCalled();
    } finally { vi.clearAllMocks(); }
  });

  it.each([false, true])('serializes POST vs CLOSED shortlist (group=%s)', async asVisit => {
    const h = fixture();
    try {
      h.add();
      const old = h.add(BookingStatus.CLOSED, asVisit ? randomUUID() : null);
      const results = await Promise.allSettled([h.create(), h.invitations.createShortlist(old.id, ['tech'], h.customer, { asVisit })]);
      const errors = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject(quotaError);
      expect(h.rows.filter(b => [BookingStatus.SUBMITTED, BookingStatus.MATCHING].includes(b.status))).toHaveLength(2);
    } finally { vi.mocked(technicianEligibility).mockReset().mockResolvedValue({ eligible: true });  }
  });

  it('serializes concurrent POSTs at one remaining slot', async () => {
    const h = fixture();
    try {
      h.add();
      const results = await Promise.allSettled([h.create(), h.create(), h.create()]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(h.rows).toHaveLength(2);
    } finally { vi.clearAllMocks(); }
  });

  it('admits a group once and returns its same-key replay at quota cap', async () => {
    const h = fixture();
    try {
      h.add();
      const input = { ...h.dto, idempotencyKey: 'same-operation', items: [{ serviceId: 'service' }, { serviceId: 'service' }] };
      const first = await h.visits.create(input, h.customer);
      const replay = await h.visits.create(input, h.customer);
      expect(replay).toEqual(first);
      expect(h.rows).toHaveLength(3);
      await expect(h.visits.create({ ...input, idempotencyKey: 'another-operation' }, h.customer)).rejects.toMatchObject(quotaError);
    } finally { vi.clearAllMocks(); }
  });

  it('rechecks group idempotency after waiting on customer lock, before rejecting quota', async () => {
    const h = fixture();
    h.add();
    const input = { ...h.dto, idempotencyKey: 'racing-retry', items: [{ serviceId: 'service' }, { serviceId: 'service' }] };
    const results = await Promise.all([h.visits.create(input, h.customer), h.visits.create(input, h.customer)]);
    expect(results[0]).toEqual(results[1]);
    expect(h.rows).toHaveLength(3);
    expect(h.events.filter(event => event === 'count')).toHaveLength(1);
  });

  it('serializes solo POST against group POST with only one available slot', async () => {
    const h = fixture();
    h.add();
    const input = { ...h.dto, items: [{ serviceId: 'service' }, { serviceId: 'service' }] };
    const results = await Promise.allSettled([h.create(), h.visits.create(input, h.customer)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject(quotaError);
  });

  it('blocks rescheduling an expired pending request back into a future window at cap', async () => {
    const h = fixture();
    h.add(); h.add();
    const old = h.add(BookingStatus.MATCHING, null, new Date('2020-01-01'));
    await expect(h.bookings.reschedule(old.id, h.dto, h.customer)).rejects.toMatchObject(quotaError);
    expect(old.preferredEndAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('keeps a pending request editable at cap without charging it a second slot', async () => {
    const h = fixture();
    const old = h.add(); h.add();
    await expect(h.bookings.reschedule(old.id, h.dto, h.customer)).resolves.toMatchObject({ id: old.id, status: BookingStatus.SUBMITTED });
    expect(h.rows).toHaveLength(2);
  });
});

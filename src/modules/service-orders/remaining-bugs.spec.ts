import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { CategoriesService } from '../categories/categories.service';
import { GeoService } from '../geo/geo.service';
import { ServiceOrdersService } from './service-orders.service';
import { CancelActor, Role, StrikeStatus } from '../../shared/enums';
import { displayRating, startOfVietnamMonth } from '../technicians/technician-earnings';

describe('#41 public categories', () => {
  it('lists only active services', async () => {
    const repo = { find: vi.fn(async () => [{ id: 'c1', services: [{ id: 's1', isActive: true }, { id: 's2', isActive: false }] }]) };
    const service = new CategoriesService(repo as never);
    const [category] = await service.findAll();
    expect(category.services.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it('keeps disabled services for the admin catalog', async () => {
    const repo = { find: vi.fn(async () => [{ id: 'c1', services: [{ id: 's1', isActive: true }, { id: 's2', isActive: false }] }]) };
    const [category] = await new CategoriesService(repo as never).findAll(false);
    expect(category.services).toHaveLength(2);
  });
});

describe('#42 province cache', () => {
  it('never answers a depth-2 request with a cached depth-1 list', async () => {
    const get = vi.fn((url: string) => of({ data: url.includes('depth=1') ? [{ code: 1 }] : [{ code: 1, districts: [{ code: 10 }] }] }));
    const geo = new GeoService({ get } as never, { get: () => undefined } as never);
    await geo.getProvinces(1);
    const withDistricts = await geo.getProvinces(2);
    expect(withDistricts[0].districts).toHaveLength(1);
    await geo.getProvinces(2);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('#28 violations come from reputation points, not a manual confirmation', () => {
  function setup(actor: CancelActor, activeStrikesAfter: number) {
    const cancellation = { id: 'cancel-1', serviceOrderId: 'order-1', actor, actorUserId: 'user-1', strikeApplied: false, reviewedByUserId: null };
    const saved: unknown[] = [];
    const updates: Array<[string, unknown, Record<string, unknown>]> = [];
    const manager = {
      create: vi.fn((_e: unknown, v: object) => v),
      save: vi.fn(async (_e: unknown, v: object) => { saved.push(v); return v; }),
      update: vi.fn(async (entity: { name: string }, where: unknown, values: Record<string, unknown>) => { updates.push([entity.name, where, values]); return {}; }),
      count: vi.fn(async () => activeStrikesAfter),
    };
    const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
      cancellationRepo: { findOneBy: vi.fn(async () => cancellation), save: vi.fn(async (v: object) => v) },
      dataSource: { transaction: (work: (m: typeof manager) => unknown) => work(manager) },
      configService: { getInt: vi.fn(async (_key: string, fallback: number) => fallback) },
      auditLogService: { log: vi.fn(async () => undefined) },
      logger: { warn: vi.fn() },
    }) as ServiceOrdersService;
    return { service, saved, updates, cancellation };
  }
  const manager = { id: 'sm-1', role: Role.SERVICE_MANAGER };

  it('refuses a manual violation: cancelling already cost reputation points (PO 09/10/2026)', async () => {
    for (const actor of [CancelActor.CUSTOMER, CancelActor.TECHNICIAN, CancelActor.SERVICE_MANAGER]) {
      const s = setup(actor, 0);
      await expect(s.service.reviewCancellation('cancel-1', { confirmViolation: true }, manager)).rejects.toThrow('không còn xác nhận vi phạm thủ công');
      expect(s.saved).toHaveLength(0);
      expect(s.updates).toHaveLength(0);
      expect(s.cancellation.strikeApplied).toBe(false);
    }
  });

  it('still waives a strike recorded before, with a reason', async () => {
    const s = setup(CancelActor.CUSTOMER, 0);
    s.cancellation.strikeApplied = true;
    await expect(s.service.reviewCancellation('cancel-1', { waiveStrike: true, waiveReason: '   ' }, manager)).rejects.toThrow('lý do miễn');
    const strike = { id: 'strike-1', status: StrikeStatus.ACTIVE } as Record<string, unknown>;
    Object.assign(s.service, { strikeRepo: { findOne: vi.fn(async () => strike), save: vi.fn(async (v: object) => v) } });
    await s.service.reviewCancellation('cancel-1', { waiveStrike: true, waiveReason: 'Khách huỷ vì thợ đến trễ' }, manager);
    expect(strike).toMatchObject({ status: StrikeStatus.WAIVED, waivedByUserId: 'sm-1', waiveReason: 'Khách huỷ vì thợ đến trễ' });
  });
});

describe('Honest ratings and the Vietnam month', () => {
  it('shows no rating before the first review', () => {
    expect(displayRating(5, 0)).toBeNull();
    expect(displayRating('4.75', 12)).toBe(4.75);
  });

  it('starts the month at 00:00 in Vietnam', () => {
    expect(startOfVietnamMonth(new Date('2026-10-31T18:30:00Z')).toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(startOfVietnamMonth(new Date('2026-10-07T12:00:00Z')).toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });
});

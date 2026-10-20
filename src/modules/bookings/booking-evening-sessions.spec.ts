import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { ScheduleBookingDto, RebookDto } from './booking.dto';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { BookingStatus } from '../../shared/enums';
import { toBookingResponse } from './booking-privacy.dto';

afterEach(() => vi.useRealTimers());

describe('customer evening session contract', () => {
  it('validates evening for schedule and rebook, rejects unknown slots', async () => {
    for (const Dto of [ScheduleBookingDto, RebookDto]) {
      expect(await validate(Object.assign(new Dto(), { mode: 'scheduled', date: '2030-10-15', slot: 'evening' }))).toEqual([]);
      expect((await validate(Object.assign(new Dto(), { slot: 'night' }))).length).toBeGreaterThan(0);
    }
  });

  it.each([['22:59', true], ['23:00', false], ['00:15', true]] as const)('offers evening at %s using the create/reschedule semantics', async (time, offered) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`2030-10-15T${time}:00+07:00`));
    const booking = { id: 'b', customerId: 'c' };
    const service = Object.create(BookingsService.prototype) as BookingsService;
    Object.assign(service, {
      bookingRepo: { findOneBy: async () => booking },
      dataSource: { manager: { findOneBy: async () => null } },
    });
    const result = await service.availableSessions('b', { id: 'c' }, 1);
    expect(result.sessions.some(s => s.date === '2030-10-15' && s.slot === 'evening' && s.available)).toBe(offered);
    if (time === '22:59') expect(result.sessions).toHaveLength(1);
  });

  it('rebooks a finished booking into the remaining evening and exposes its slot/window in the response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-10-15T22:59:00+07:00'));
    const old = { id: 'old', customerId: 'c', status: BookingStatus.CANCELLED, addressId: 'address', serviceId: 'service', quantity: 1, description: 'Synthetic repair' };
    const stored = { create: (value: object) => value, save: async (value: object) => ({ id: 'new', ...value }) };
    const manager = {
      findOneBy: async () => null,
      getRepository: (entity: unknown) => entity === Booking ? stored : {},
    };
    const service = Object.create(BookingsService.prototype) as BookingsService;
    Object.assign(service, {
      bookingRepo: { findOneBy: async () => old },
      dataSource: { manager, transaction: async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager) },
      userRepo: { findOneBy: async () => ({ id: 'c' }) },
      serviceRepo: { findOneBy: async () => ({ id: 'service', code: 'LEGACY_REPAIR', name: 'Synthetic', isActive: true, pricingMode: 'inspection_required' }) },
      addressRepo: { findOneBy: async () => ({ userId: 'c', line1: 'Synthetic', lat: 10, lng: 106 }) },
      auditLogService: { log: async () => undefined },
    });
    const result = await service.rebook('old', { id: 'c', role: 'customer' }, { mode: 'scheduled', date: '2030-10-15', slot: 'evening' } as RebookDto);
    const response = toBookingResponse(result.booking);
    expect(response).toMatchObject({ bookingMode: 'scheduled', slot: 'evening',
      preferredStartAt: new Date('2030-10-15T22:59:00+07:00'), preferredEndAt: new Date('2030-10-15T23:00:00+07:00') });
  });

  it('reschedules into the remaining evening and rejects the same session once it ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-10-15T22:59:00+07:00'));
    const booking = { id: 'b', customerId: 'c', status: BookingStatus.SUBMITTED };
    const qb = { update: () => qb, set: () => qb, where: () => qb, execute: async () => ({}) };
    const manager = {
      findOne: async (entity: unknown) => entity === Booking ? booking : null,
      createQueryBuilder: () => qb,
      save: async (value: unknown) => value,
    };
    const service = Object.create(BookingsService.prototype) as BookingsService;
    Object.assign(service, {
      dataSource: { transaction: async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager) },
      auditLogService: { logWithManager: async () => undefined },
    });
    const dto = { mode: 'scheduled' as const, date: '2030-10-15', slot: 'evening' as const };
    expect(await service.reschedule('b', dto, { id: 'c' })).toMatchObject({ slot: 'evening',
      preferredStartAt: new Date('2030-10-15T22:59:00+07:00'), preferredEndAt: new Date('2030-10-15T23:00:00+07:00') });
    vi.setSystemTime(new Date('2030-10-15T23:00:00+07:00'));
    await expect(service.reschedule('b', dto, { id: 'c' })).rejects.toThrow();
  });
});

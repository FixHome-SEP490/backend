import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import type { Booking } from './entities/booking.entity';
import { technicianEligibility } from './technician-eligibility';
import { BookingsService } from './bookings.service';

const day = '2030-10-15'; // Tuesday in Vietnam, 10:00 local = 03:00Z.
const at = (hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);

function fixture() {
  const booking = {
    id: 'booking-1', serviceId: 'service-1', addressId: 'address-1',
    latitudeSnapshot: 10.77, longitudeSnapshot: 106.7,
    preferredStartAt: at(10), preferredEndAt: at(12),
  } as Booking;
  const user = { id: 'tech-1', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE };
  const profile = { id: 'profile-1', verificationStatus: VerificationStatus.VERIFIED,
    isAvailable: true, workSuspendedUntil: null as Date | null, serviceRadiusKm: 10 };
  const schedules = [{ dayOfWeek: 2, startTime: '08:00', endTime: '18:00' }];
  let verifiedSkill = true;
  let unpaidDues = false;
  let missingAddress = false;
  const timeOff: Array<{ startAt: Date; endAt: Date }> = [];
  const assignments: Array<{ busyStart: Date | null; busyEnd: Date | null; status?: string; slot?: string | null; mode?: string }> = [];
  const areas: Array<{ provinceCode: string; districtCode: string }> = [];
  const manager = {
    findOneBy: vi.fn(async (entity: { name?: string }) => {
      if (entity.name === 'User') return user;
      if (entity.name === 'TechnicianProfile') return profile;
      if (entity.name === 'TechnicianSkill') return verifiedSkill ? { id: 'skill' } : null;
      if (entity.name === 'Address') return missingAddress ? null : { lat: 10.77, lng: 106.7 };
      return null;
    }),
    count: vi.fn(async () => Number(unpaidDues)),
    find: vi.fn(async (entity: { name?: string }) => {
      if (entity.name === 'TechnicianSchedule') return schedules;
      if (entity.name === 'TechnicianServiceArea') return areas;
      return [];
    }),
    createQueryBuilder: vi.fn((entity: { name?: string } | string) => {
      const isBusy = typeof entity === 'string';
      const qb = {
        select: vi.fn(() => qb), addSelect: vi.fn(() => qb),
        innerJoin: vi.fn(() => qb), leftJoin: vi.fn(() => qb),
        where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
        getCount: vi.fn(async () => 0),
        getMany: vi.fn(async () => timeOff),
        getRawMany: vi.fn(async () => isBusy ? assignments : []),
      };
      return qb;
    }),
  };
  return { booking, user, profile, schedules, timeOff, assignments, areas,
    manager: manager as unknown as EntityManager,
    revokeSkill: () => { verifiedSkill = false; },
    setDues: () => { unpaidDues = true; },
    removeAddress: () => { missingAddress = true; },
  };
}
const allowed = async (f: ReturnType<typeof fixture>, excludeOrderId?: string) =>
  (await technicianEligibility(f.manager, 'tech-1', f.booking, excludeOrderId)).eligible;

describe('ARRIVAL: actual shared technicianEligibility permits a valid arrival subset', () => {
  it('allows customer 17-19 when shift finishes 18, rejects 18-19 with no overlap', async () => {
    const f = fixture();
    expect(await allowed(f)).toBe(true);
    f.booking.preferredStartAt = at(11);
    expect(await allowed(f)).toBe(false);
  });
  it('blocks any time off inside the window (PO 08/10), still permits a partial active assignment', async () => {
    const f = fixture();
    f.timeOff.push({ startAt: at(10), endAt: at(10, 30) });
    expect(await allowed(f)).toBe(false);
    f.timeOff.length = 0;
    f.assignments.push({ busyStart: at(10), busyEnd: at(10, 30) });
    expect(await allowed(f)).toBe(true);
    f.assignments.push({ busyStart: at(10, 30), busyEnd: at(11) });
    expect(await allowed(f)).toBe(false);
  });
  it('blocks malformed/missing busy booking intervals rather than interpreting them as free time', async () => {
    for (const assignment of [
      { busyStart: null, busyEnd: null },
      { busyStart: at(10), busyEnd: null },
      { busyStart: null, busyEnd: at(11) },
    ]) {
      const f = fixture();
      f.assignments.push(assignment);
      expect(await allowed(f)).toBe(false);
    }
  });
  it('allows next local day shift if customer arrival window spans midnight', async () => {
    const f = fixture();
    f.booking.preferredStartAt = new Date('2030-10-15T16:00:00Z');
    f.booking.preferredEndAt = new Date('2030-10-16T02:00:00Z');
    f.schedules.length = 0;
    f.schedules.push({ dayOfWeek: 3, startTime: '08:00', endTime: '18:00' });
    expect(await allowed(f)).toBe(true);
  });
  it('still blocks paused NEW, suspended technician, unverified skill, dues and missing address', async () => {
    const f = fixture();
    f.profile.isAvailable = false;
    expect(await allowed(f)).toBe(false);
    expect((await technicianEligibility(f.manager, 'tech-1', f.booking, undefined,
      { allowPausedExistingInvitation: true })).eligible).toBe(true);
    f.profile.isAvailable = true;
    f.profile.workSuspendedUntil = new Date('2031-01-01T00:00:00Z');
    expect(await allowed(f)).toBe(false);
    f.profile.workSuspendedUntil = null;
    f.revokeSkill();
    expect(await allowed(f)).toBe(false);
    const d = fixture(); d.setDues(); expect(await allowed(d)).toBe(false);
    const a = fixture(); a.removeAddress(); expect(await allowed(a)).toBe(false);
  });
  it('rejects an expired window and a window with no technician schedule', async () => {
    const expired = fixture();
    expired.booking.preferredEndAt = new Date('2020-10-15T04:00:00Z');
    expect(await allowed(expired)).toBe(false);

    const unscheduled = fixture();
    unscheduled.schedules.length = 0;
    expect(await allowed(unscheduled)).toBe(false);
  });
  it('ignores an already elapsed arrival segment even when booking ends in the future', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-10-15T03:15:00Z')); // 10:15 local
      const f = fixture();
      f.booking.preferredStartAt = new Date('2030-10-15T03:00:00Z');
      f.booking.preferredEndAt = new Date('2030-10-15T04:00:00Z');
      f.schedules.length = 0;
      f.schedules.push({ dayOfWeek: 2, startTime: '08:00', endTime: '10:10' });
      expect(await allowed(f)).toBe(false); // 10:00-10:10 passed; no future arrival
      f.schedules[0].endTime = '10:30';
      expect(await allowed(f)).toBe(true); // 10:15-10:30 still possible
    } finally {
      vi.useRealTimers();
    }
  });
  it('passes existing excludeOrderId into the busy-assignment query to preserve rescheduling', async () => {
    const f = fixture();
    expect(await allowed(f, 'order-to-exclude')).toBe(true);
    const calls = vi.mocked(f.manager.createQueryBuilder).mock.results;
    const busyBuilder = calls[calls.length - 1].value;
    expect(busyBuilder.addSelect).toHaveBeenCalledWith('b.preferred_start_at', 'busyStart');
    expect(busyBuilder.addSelect).toHaveBeenCalledWith('b.preferred_end_at', 'busyEnd');
    expect(busyBuilder.andWhere).toHaveBeenCalledWith('o.id != :excludeOrderId', { excludeOrderId: 'order-to-exclude' });
  });
});

describe('sessions and urgent bookings (PO 08/10/2026)', () => {
  it.each([false, true])('checks the remaining evening against the technician for availableSessions (previous=%s)', async previous => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(15, 59));
      const f = fixture();
      f.schedules[0].endTime = '23:00';
      const findOneBy = vi.mocked(f.manager.findOneBy).getMockImplementation()!;
      vi.mocked(f.manager.findOneBy).mockImplementation(async (entity, where) => {
        if (typeof entity === 'function' && entity.name === 'ServiceOrder') return { id: 'old-order' };
        if (typeof entity === 'function' && entity.name === 'TechnicianAssignment') return { technicianId: 'tech-1' };
        return findOneBy(entity, where);
      });
      Object.assign(f.manager, { findOne: async () => ({ technicianId: 'tech-1' }) });
      const service = Object.create(BookingsService.prototype) as BookingsService;
      Object.assign(service, { bookingRepo: { findOneBy: async () => f.booking }, dataSource: { manager: f.manager } });
      const sessions = async () => (await service.availableSessions('booking-1', { id: 'c' }, 1, previous)).sessions;
      expect(await sessions()).toMatchObject([{ slot: 'evening', available: true }]);
      f.assignments.push({ busyStart: at(11), busyEnd: at(16), slot: 'evening', mode: 'scheduled', status: 'completed' });
      expect(await sessions()).toMatchObject([{ slot: 'evening', available: false }]);
    } finally { vi.useRealTimers(); }
  });
  it.each(['en_route', 'under_repair'])('blocks urgent across midnight while %s, regardless of the old arrival end', async status => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-10-16T00:15:00+07:00'));
      const f = fixture();
      f.schedules.splice(0, f.schedules.length, { dayOfWeek: 2, startTime: '18:00', endTime: '02:00' });
      Object.assign(f.booking, { bookingMode: 'urgent', slot: null,
        preferredStartAt: new Date('2030-10-16T00:15:00+07:00'), preferredEndAt: new Date('2030-10-16T02:15:00+07:00') });
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(6), busyEnd: at(11), slot: 'afternoon', mode: 'scheduled', status });
      expect(await allowed(f)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('blocks a started evening appointment while an urgent order is already accepted', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(15, 30)); // 22:30 Vietnam
      const f = fixture();
      f.schedules[0].endTime = '23:00';
      Object.assign(f.booking, {
        bookingMode: 'scheduled', slot: 'evening',
        preferredStartAt: at(15, 30), preferredEndAt: at(16),
      });
      f.assignments.push({ busyStart: at(14), busyEnd: at(16), slot: null, mode: 'urgent', status: 'accepted' });
      expect(await allowed(f)).toBe(false);
      f.assignments[0].status = 'completed';
      expect(await allowed(f)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('does not treat tomorrow accepted appointment as a job being performed now or another session being taken', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-10-15T22:59:00+07:00'));
      const f = fixture();
      f.schedules[0].endTime = '23:00';
      Object.assign(f.booking, { bookingMode: 'urgent', slot: null, preferredStartAt: at(15, 59), preferredEndAt: at(17, 59) });
      f.assignments.push({ busyStart: new Date('2030-10-16T01:00:00Z'), busyEnd: new Date('2030-10-16T05:00:00Z'), slot: 'morning', mode: 'scheduled', status: 'accepted' });
      expect(await allowed(f)).toBe(true);
      Object.assign(f.booking, { bookingMode: 'scheduled', slot: 'evening', preferredEndAt: at(16) });
      expect(await allowed(f)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('requires working shift overlap after 23:00, including a shift from the previous Vietnam date', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(16)); // Tuesday 23:00 Vietnam
      const f = fixture();
      Object.assign(f.booking, { bookingMode: 'urgent', slot: null, preferredStartAt: at(16), preferredEndAt: at(18) });
      f.schedules[0].endTime = '23:00';
      expect(await allowed(f)).toBe(false);
      f.schedules[0] = { dayOfWeek: 2, startTime: '18:00', endTime: '02:00' };
      expect(await allowed(f)).toBe(true);
      vi.setSystemTime(at(17, 15)); // Wednesday 00:15 Vietnam, still Tuesday's shift
      f.booking.preferredStartAt = at(17, 15);
      f.booking.preferredEndAt = at(19, 15);
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(11), busyEnd: at(16), slot: 'evening', mode: 'scheduled', status: 'under_repair' });
      expect(await allowed(f)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(['accepted', 'completed'])('prevents a second evening booking even when first is %s', async status => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(15, 59));
      const f = fixture();
      f.schedules[0].endTime = '23:00';
      Object.assign(f.booking, { bookingMode: 'scheduled', slot: 'evening', preferredStartAt: at(15, 59), preferredEndAt: at(16) });
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(11), busyEnd: at(16), slot: 'evening', mode: 'scheduled', status });
      expect(await allowed(f)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not infer a repair completion time from an earlier arrival window for a current evening booking', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(15, 59));
      const f = fixture();
      f.schedules[0].endTime = '23:00';
      Object.assign(f.booking, { bookingMode: 'scheduled', slot: 'evening', preferredStartAt: at(15, 59), preferredEndAt: at(16) });
      f.assignments.push({ busyStart: at(6), busyEnd: at(11), slot: 'afternoon', mode: 'scheduled', status: 'under_repair' });
      expect(await allowed(f)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  // 2030-10-15 morning session = 01:00-05:00Z, afternoon = 06:00-11:00Z.
  const morning = (f: ReturnType<typeof fixture>) => {
    Object.assign(f.booking, { bookingMode: 'scheduled', slot: 'morning', preferredStartAt: at(1), preferredEndAt: at(5) });
  };

  it('allows one scheduled booking per session, even after the job of that session is completed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-10-14T00:00:00Z'));
    try {
      const f = fixture();
      morning(f);
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(1), busyEnd: at(5), slot: 'morning', mode: 'scheduled', status: 'completed' });
      expect(await allowed(f)).toBe(false);
      f.assignments[0].slot = 'afternoon';
      f.assignments[0].busyStart = at(6);
      f.assignments[0].busyEnd = at(11);
      expect(await allowed(f)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('urgent: not while on another job, nor in a session whose scheduled job is not done', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2)); // 09:00 Vietnam, morning session
    try {
      const f = fixture();
      Object.assign(f.booking, { bookingMode: 'urgent', slot: null, preferredStartAt: at(2), preferredEndAt: at(4) });
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(1), busyEnd: at(5), slot: 'morning', mode: 'scheduled', status: 'accepted' });
      expect(await allowed(f)).toBe(false);
      f.assignments[0].status = 'completed';
      expect(await allowed(f)).toBe(true);
      f.assignments.push({ busyStart: at(1), busyEnd: at(3), slot: null, mode: 'urgent', status: 'en_route' });
      expect(await allowed(f)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves only the chosen districts when measured from the work address', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-10-14T00:00:00Z'));
    try {
      const f = fixture();
      morning(f);
      Object.assign(f.booking, { provinceSnapshot: '79', districtSnapshot: '760' });
      f.areas.push({ provinceCode: '79', districtCode: '761' });
      expect(await allowed(f)).toBe(false);
      f.areas.push({ provinceCode: '79', districtCode: '760' });
      expect(await allowed(f)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

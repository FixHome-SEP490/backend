import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import type { Booking } from './entities/booking.entity';
import { technicianEligibility } from './technician-eligibility';

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
  const assignments: Array<{ busyStart: Date | null; busyEnd: Date | null }> = [];
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
      return [];
    }),
    createQueryBuilder: vi.fn((entity: { name?: string } | string) => {
      const isBusy = typeof entity === 'string';
      const qb = {
        select: vi.fn(() => qb), addSelect: vi.fn(() => qb),
        innerJoin: vi.fn(() => qb), leftJoin: vi.fn(() => qb),
        where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
        getMany: vi.fn(async () => timeOff),
        getRawMany: vi.fn(async () => isBusy ? assignments : []),
      };
      return qb;
    }),
  };
  return { booking, user, profile, schedules, timeOff, assignments,
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
  it('permits a partial TimeOff and a partial active assignment, not a fully blocked interval', async () => {
    const f = fixture();
    f.timeOff.push({ startAt: at(10), endAt: at(10, 30) });
    expect(await allowed(f)).toBe(true);
    f.assignments.push({ busyStart: at(10, 30), busyEnd: at(11) });
    expect(await allowed(f)).toBe(false);
    f.assignments.length = 0;
    f.timeOff.length = 0;
    f.assignments.push({ busyStart: at(10), busyEnd: at(10, 30) });
    expect(await allowed(f)).toBe(true);
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
    expect(busyBuilder.select).toHaveBeenCalledWith('b.preferred_start_at', 'busyStart');
    expect(busyBuilder.addSelect).toHaveBeenCalledWith('b.preferred_end_at', 'busyEnd');
    expect(busyBuilder.andWhere).toHaveBeenCalledWith('o.id != :excludeOrderId', { excludeOrderId: 'order-to-exclude' });
  });
});

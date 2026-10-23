import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import type { Booking } from './entities/booking.entity';
import { loadEligibilityPreload, technicianEligibility } from './technician-eligibility';

// PO 21/10/2026: the reschedule calendar read the technician once per session
// (about 15 s for two weeks). The data is now read once and every session is
// judged from it, with the same verdicts as before and no further queries.
const day = '2030-10-15';
const at = (hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

function fixture() {
  const user = { id: 'tech-1', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE };
  const profile = { id: 'profile-1', verificationStatus: VerificationStatus.VERIFIED, isAvailable: true, workSuspendedUntil: null, serviceRadiusKm: 10 };
  const schedules = [{ dayOfWeek: 2, startTime: '08:00', endTime: '18:00' }];
  const timeOff: Array<{ startAt: Date; endAt: Date }> = [];
  const held: Array<{ orderId: string; status: string; slot: string | null; mode: string | null; busyStart: Date | null; busyEnd: Date | null }> = [];
  const manager = {
    findOneBy: vi.fn(async (entity: { name?: string }) => (entity.name === 'User' ? user : entity.name === 'TechnicianProfile' ? profile : null)),
    find: vi.fn(async (entity: { name?: string }) => (entity.name === 'TechnicianSchedule' ? schedules : [])),
    count: vi.fn(async () => 0),
    createQueryBuilder: vi.fn((entity: unknown) => {
      const qb = {
        select: vi.fn(() => qb), addSelect: vi.fn(() => qb), innerJoin: vi.fn(() => qb),
        where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
        getCount: vi.fn(async () => 0),
        getMany: vi.fn(async () => timeOff),
        getRawMany: vi.fn(async () => (typeof entity === 'string' ? held : [])),
      };
      return qb;
    }),
  };
  const probe = (start: Date, end: Date) => ({ id: 'booking-1', serviceId: 'service-1', preferredStartAt: start, preferredEndAt: end } as Booking);
  return { manager, timeOff, held, probe, asManager: manager as unknown as EntityManager };
}

const range = { start: at(0), end: at(23) };

describe('technician availability read once for many sessions', () => {
  it('gives the same verdicts as reading per session, then asks the database nothing more', async () => {
    const f = fixture();
    f.held.push({ orderId: 'other', status: 'accepted', slot: null, mode: 'scheduled', busyStart: at(14), busyEnd: at(16) });
    const windows: Array<[Date, Date]> = [[at(10), at(12)], [at(14), at(16)], [at(17), at(19)], [at(19), at(21)]];
    const direct = [];
    for (const [s, e] of windows) direct.push(await technicianEligibility(f.asManager, 'tech-1', f.probe(s, e), 'own-order', { keepingExistingOrder: true }));

    const preload = await loadEligibilityPreload(f.asManager, 'tech-1', range, 'own-order');
    for (const fn of Object.values(f.manager)) fn.mockClear();
    const batched = [];
    for (const [s, e] of windows) batched.push(await technicianEligibility(f.asManager, 'tech-1', f.probe(s, e), 'own-order', { keepingExistingOrder: true, preload }));

    expect(batched).toEqual(direct);
    expect(batched.some((v) => v.eligible)).toBe(true);
    expect(batched.some((v) => !v.eligible)).toBe(true);
    for (const fn of Object.values(f.manager)) expect(fn).not.toHaveBeenCalled();
  });

  it('applies time off only to the sessions it overlaps', async () => {
    const f = fixture();
    f.timeOff.push({ startAt: at(10), endAt: at(10, 30) });
    const preload = await loadEligibilityPreload(f.asManager, 'tech-1', range);
    const morning = await technicianEligibility(f.asManager, 'tech-1', f.probe(at(10), at(12)), undefined, { keepingExistingOrder: true, preload });
    // 02:00-04:00Z is 09:00-11:00 in Vietnam, inside the 08-18 shift and clear of the time off.
    const otherSession = await technicianEligibility(f.asManager, 'tech-1', f.probe(at(2), at(4)), undefined, { keepingExistingOrder: true, preload });
    expect(morning).toEqual({ eligible: false, reason: 'Technician has time off' });
    expect(otherSession).toEqual({ eligible: true });
  });

  it('is ignored outside the keep-my-order check, which still reads everything it needs', async () => {
    const f = fixture();
    const preload = await loadEligibilityPreload(f.asManager, 'tech-1', range);
    for (const fn of Object.values(f.manager)) fn.mockClear();
    await technicianEligibility(f.asManager, 'tech-1', f.probe(at(10), at(12)), undefined, { preload });
    expect(f.manager.findOneBy).toHaveBeenCalled();
  });
});

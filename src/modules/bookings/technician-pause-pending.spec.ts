import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import type { Booking } from './entities/booking.entity';
import { technicianEligibility } from './technician-eligibility';

function scenario() {
  const user = { id: 'tech-1', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE };
  const profile = { id: 'profile-1', userId: user.id, verificationStatus: VerificationStatus.VERIFIED,
    isAvailable: false, workSuspendedUntil: null as Date | null };
  let hasVerifiedSkill = true;
  let hasTimeOff = false;
  let hasConflict = false;
  const booking = { id: 'booking-1', serviceId: 'service-1', addressId: 'address-1',
    provinceSnapshot: '79', districtSnapshot: '760',
    preferredStartAt: new Date('2030-10-15T03:00:00Z'),
    preferredEndAt: new Date('2030-10-15T04:00:00Z') } as Booking;
  const manager = {
    findOneBy: vi.fn(async (entity: { name?: string }) => {
      if (entity.name === 'User') return user;
      if (entity.name === 'TechnicianProfile') return profile;
      if (entity.name === 'TechnicianSkill') return hasVerifiedSkill ? { id: 'verified-skill-1' } : null;
      return null;
    }),
    count: vi.fn(async () => 0),
    find: vi.fn(async (entity: { name?: string }) => {
      if (entity.name === 'TechnicianSchedule') return [{ dayOfWeek: 2, startTime: '08:00', endTime: '18:00' }];
      if (entity.name === 'TechnicianServiceArea') return [{ provinceCode: '79', districtCode: '760' }];
      return [];
    }),
    createQueryBuilder: vi.fn((entity: { name?: string } | string) => {
      const qb = {
        select: vi.fn(() => qb), addSelect: vi.fn(() => qb),
        innerJoin: vi.fn(() => qb), where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
        getMany: vi.fn(async () => hasTimeOff && typeof entity !== 'string'
          ? [{ startAt: booking.preferredStartAt!, endAt: booking.preferredEndAt! }]
          : []),
        getRawMany: vi.fn(async () => hasConflict && typeof entity === 'string'
          ? [{ busyStart: booking.preferredStartAt, busyEnd: booking.preferredEndAt }]
          : []),
      };
      return qb;
    }),
  };
  return { manager: manager as unknown as EntityManager, booking, user, profile,
    revokeSkill: () => { hasVerifiedSkill = false; },
    setTimeOff: () => { hasTimeOff = true; },
    setConflict: () => { hasConflict = true; } };
}

const issuedPendingOption = { allowPausedExistingInvitation: true };

describe('PAUSE-PENDING=A: paused technician may accept already-issued valid PENDING, not new invites', () => {
  it('rejects paused technician by default for discovery/new shortlist/new invitation', async () => {
    const s = scenario();
    const verdict = await technicianEligibility(s.manager, 'tech-1', s.booking);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/unavailable|paused/i);
  });

  it('permits a paused technician for a validated already-issued PENDING invitation only', async () => {
    const s = scenario();
    const verdict = await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption);
    expect(verdict.eligible).toBe(true);
  });

  it('allows NEW invitations again after resume, with no special option', async () => {
    const s = scenario();
    s.profile.isAvailable = true;
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking)).eligible).toBe(true);
  });

  it('never overrides a real work suspension, even for an already-issued PENDING invitation', async () => {
    const s = scenario();
    s.profile.workSuspendedUntil = new Date('2031-01-01T00:00:00Z');
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption)).eligible).toBe(false);
  });

  it('does not bypass invalid account or unverified profile or revoked skill', async () => {
    const s = scenario();
    s.user.status = AccountStatus.SUSPENDED;
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption)).eligible).toBe(false);
    s.user.status = AccountStatus.ACTIVE;
    s.profile.verificationStatus = VerificationStatus.PENDING;
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption)).eligible).toBe(false);
    s.profile.verificationStatus = VerificationStatus.VERIFIED;
    s.revokeSkill();
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption)).eligible).toBe(false);
  });

  it('does not bypass TimeOff, existing assignment conflict or an expired booking window', async () => {
    const s = scenario();
    s.setTimeOff();
    expect((await technicianEligibility(s.manager, 'tech-1', s.booking, undefined, issuedPendingOption)).eligible).toBe(false);
    const u = scenario();
    u.setConflict();
    expect((await technicianEligibility(u.manager, 'tech-1', u.booking, undefined, issuedPendingOption)).eligible).toBe(false);
    const v = scenario();
    v.booking.preferredEndAt = new Date('2020-10-15T04:00:00Z');
    expect((await technicianEligibility(v.manager, 'tech-1', v.booking, undefined, issuedPendingOption)).eligible).toBe(false);
  });
});

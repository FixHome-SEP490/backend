import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { OnboardingStatus, VerificationStatus } from '../../shared/enums';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { OfficeVisit, OfficeVisitStatus } from './entities/office-visit.entity';
import { VisitOffice } from './entities/visit-office.entity';
import { OfficeVisitsService } from './office-visits.service';
import { ProfileReviewService } from './profile-review.service';

const technicianId = 'tech-1';
const MONDAY_8AM = new Date('2026-11-09T01:00:00Z');
const office = {
  id: 'office-1', name: 'Trụ sở Quận 1', address: '12 Lê Lợi', phone: null, latitude: null, longitude: null, isActive: true,
  visitDays: [1, 2, 3, 4, 5], openTime: '08:00', closeTime: '17:00', lunchStart: '11:30', lunchEnd: '13:30', slotMinutes: 60, slotCapacity: 1,
};
const config = (over: Record<string, string | number> = {}) => ({
  getInt: vi.fn(async (key: string, d: number) => (over[key] as number) ?? d),
  getString: vi.fn(async (key: string, d: string) => (over[key] as string) ?? d),
});

function visitsHarness(opts: { profile?: Record<string, unknown>; existing?: Record<string, unknown>[] } = {}) {
  const profile = { id: 'p1', userId: technicianId, identityVerifiedAt: new Date(), verificationStatus: VerificationStatus.PENDING, onboardingStatus: OnboardingStatus.SUBMITTED, ...opts.profile };
  const rows: Array<Record<string, unknown>> = (opts.existing ?? []).map((v, i) => ({ id: `v${i}`, technicianId, officeId: office.id, scheduledAt: new Date(), ...v }));
  const visitRepo = {
    exists: vi.fn(async ({ where }) => rows.some((r) => r.technicianId === where.technicianId && r.status === where.status)),
    count: vi.fn(async ({ where }) => rows.filter((r) => r.technicianId === where.technicianId && r.status === where.status).length),
    update: vi.fn(),
    find: vi.fn(async ({ where }) => rows.filter((r) => !where.officeId || r.officeId === where.officeId)),
    create: vi.fn((v) => v),
    save: vi.fn(async (v) => ({ id: 'new-visit', ...v })),
    findOne: vi.fn(async ({ where }) => rows.find((r) => r.id === where.id) ?? null),
  };
  const officeRepo = { findOne: vi.fn().mockResolvedValue(office), find: vi.fn().mockResolvedValue([office]) };
  const manager = {
    transaction: async (cb: (m: unknown) => unknown) => cb(manager),
    getRepository: (entity: unknown) => (entity === TechnicianProfile ? { findOne: vi.fn().mockResolvedValue(profile) } : entity === VisitOffice ? officeRepo : visitRepo),
  };
  const visitsWithManager = { ...visitRepo, manager };
  const notifications = { createNotification: vi.fn().mockResolvedValue(undefined) };
  const audit = { log: vi.fn() };
  const service = new OfficeVisitsService(
    officeRepo as never,
    visitsWithManager as never,
    { findOne: vi.fn().mockResolvedValue(profile) } as never,
    config({ 'office.support_phone': '0900000000' }) as never,
    audit as never,
    notifications as never,
  );
  return { service, visitRepo, notifications };
}

describe('OfficeVisitsService.book', () => {
  vi.useFakeTimers({ now: MONDAY_8AM, toFake: ['Date'] });

  it('books a valid open slot and cancels the previous waiting visit', async () => {
    const { service, visitRepo } = visitsHarness();
    const view = await service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z' }); // 14:00 giờ Việt Nam
    expect(visitRepo.update).toHaveBeenCalledWith({ technicianId, status: OfficeVisitStatus.SCHEDULED }, { status: OfficeVisitStatus.CANCELLED });
    expect(view).toMatchObject({ officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z', status: OfficeVisitStatus.SCHEDULED });
  });

  it('refuses before the identity is confirmed', async () => {
    const { service } = visitsHarness({ profile: { identityVerifiedAt: null } });
    await expect(service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z' })).rejects.toThrow(ForbiddenException);
  });

  it('refuses a time that is not an open slot, or one that is already full', async () => {
    const { service } = visitsHarness({ existing: [{ officeId: office.id, scheduledAt: new Date('2026-11-09T08:00:00Z'), status: OfficeVisitStatus.SCHEDULED, technicianId: 'someone-else' }] });
    await expect(service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:10:00.000Z' })).rejects.toThrow(BadRequestException);
    await expect(service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T08:00:00.000Z' })).rejects.toThrow(BadRequestException); // 15:00, hết chỗ
  });

  it('allows one more booking after the first miss, then blocks and tells the technician who to call', async () => {
    const missed = (n: number) => Array.from({ length: n }, () => ({ status: OfficeVisitStatus.MISSED }));
    const once = visitsHarness({ existing: missed(1) });
    await expect(once.service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z' })).resolves.toBeDefined();

    const twice = visitsHarness({ existing: missed(2) });
    await expect(twice.service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z' })).rejects.toThrow(/0900000000/);
  });

  it('does not book once the technician has already met the office', async () => {
    const { service } = visitsHarness({ existing: [{ status: OfficeVisitStatus.ATTENDED }] });
    await expect(service.book(technicianId, { officeId: office.id, scheduledAt: '2026-11-09T07:00:00.000Z' })).rejects.toThrow(BadRequestException);
  });
});

describe('OfficeVisitsService.markMissed', () => {
  it('first miss invites a rebooking, the second blocks and notifies with the support phone', async () => {
    const first = visitsHarness({ existing: [{ id: 'cur', status: OfficeVisitStatus.SCHEDULED }] });
    first.visitRepo.count.mockResolvedValue(1);
    await first.service.markMissed('cur', 'admin-1');
    expect(first.notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFICE_VISIT_MISSED', userId: technicianId }));

    const second = visitsHarness({ existing: [{ id: 'cur', status: OfficeVisitStatus.SCHEDULED }] });
    second.visitRepo.count.mockResolvedValue(2);
    const result = await second.service.markMissed('cur', 'admin-1');
    expect(result).toMatchObject({ blocked: true, missedVisits: 2 });
    expect(second.notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFICE_VISIT_BLOCKED', message: expect.stringContaining('0900000000') }));
  });

  it('cannot process the same appointment twice', async () => {
    const { service } = visitsHarness({ existing: [{ status: OfficeVisitStatus.ATTENDED }] });
    await expect(service.markMissed('v0', 'admin-1')).rejects.toThrow(ConflictException);
  });
});

function reviewHarness(opts: { attended: boolean; profile?: Record<string, unknown> }) {
  const profile = { id: 'p1', userId: technicianId, identityVerifiedAt: new Date(), verificationStatus: VerificationStatus.PENDING, onboardingStatus: OnboardingStatus.SUBMITTED, ...opts.profile };
  const skills = [
    { id: 's1', technicianId: 'p1', level: 'INTERMEDIATE', verificationStatus: VerificationStatus.PENDING },
    { id: 's2', technicianId: 'p1', level: 'INTERMEDIATE', verificationStatus: VerificationStatus.PENDING },
  ];
  const skillSave = vi.fn(async (s) => s);
  const skillReviews = { findOne: vi.fn().mockResolvedValue(null), update: vi.fn(), save: vi.fn(), create: vi.fn((v) => v) };
  const profileSave = vi.fn(async (p) => p);
  const wallets = { findOne: vi.fn().mockResolvedValue(null), save: vi.fn(), create: vi.fn((v) => v) };
  const repos = new Map<unknown, unknown>([
    [TechnicianProfile, { findOne: vi.fn().mockResolvedValue(profile), save: profileSave }],
    [OfficeVisit, { exists: vi.fn().mockResolvedValue(opts.attended) }],
    [TechnicianSkill, { find: vi.fn().mockResolvedValue(skills), save: skillSave }],
    [TechnicianSkillVerification, skillReviews],
    [Wallet, wallets],
  ]);
  const manager = { transaction: async (cb: (m: unknown) => unknown) => cb(manager), getRepository: (e: unknown) => repos.get(e) };
  const notifications = { createNotification: vi.fn().mockResolvedValue(undefined) };
  const audit = { logWithManagerStrict: vi.fn(), log: vi.fn() };
  const service = new ProfileReviewService(
    { manager, findOne: vi.fn().mockResolvedValue(profile), update: vi.fn() } as never,
    {} as never,
    {} as never,
    config() as never,
    audit as never,
    notifications as never,
  );
  return { service, profile, skills, skillReviews, wallets, notifications };
}

describe('ProfileReviewService.approve', () => {
  const decisions = { skills: [{ skillId: 's1', level: 'ADVANCED', approved: true }, { skillId: 's2', level: 'BEGINNER', approved: false }] };

  it('approves only after the office visit, confirming the level per skill and creating the wallet', async () => {
    const { service, profile, skills, skillReviews, wallets, notifications } = reviewHarness({ attended: true });
    await service.approve(technicianId, 'admin-1', decisions);
    expect(profile.verificationStatus).toBe(VerificationStatus.VERIFIED);
    expect(profile.onboardingStatus).toBe(OnboardingStatus.APPROVED);
    expect(skills[0]).toMatchObject({ level: 'ADVANCED', verificationStatus: VerificationStatus.VERIFIED });
    expect(skills[1]).toMatchObject({ level: 'BEGINNER', verificationStatus: VerificationStatus.REJECTED });
    expect(skillReviews.save).toHaveBeenCalledTimes(2);
    expect(wallets.save).toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'WALLET_TOPUP_REQUIRED' }));
  });

  it('refuses to approve before the technician has met the office', async () => {
    const { service, profile } = reviewHarness({ attended: false });
    await expect(service.approve(technicianId, 'admin-1', decisions)).rejects.toThrow(BadRequestException);
    expect(profile.verificationStatus).toBe(VerificationStatus.PENDING);
  });

  it('needs at least one confirmed skill, and refuses a profile whose identity is not confirmed', async () => {
    const { service } = reviewHarness({ attended: true });
    await expect(service.approve(technicianId, 'admin-1', { skills: [{ skillId: 's1', level: 'ADVANCED', approved: false }] })).rejects.toThrow(BadRequestException);
    const noIdentity = reviewHarness({ attended: true, profile: { identityVerifiedAt: null } });
    await expect(noIdentity.service.approve(technicianId, 'admin-1', decisions)).rejects.toThrow(BadRequestException);
  });

  it('refuses a skill that does not belong to the technician', async () => {
    const { service } = reviewHarness({ attended: true });
    await expect(service.approve(technicianId, 'admin-1', { skills: [{ skillId: 'foreign', level: 'ADVANCED', approved: true }] })).rejects.toThrow(BadRequestException);
  });
});

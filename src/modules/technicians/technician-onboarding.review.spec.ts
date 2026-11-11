import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TechnicianOnboardingService } from './technician-onboarding.service';
import { OnboardingStatus, Role, VerificationStatus } from '../../shared/enums';

const userId = 'user-1';

function build(over: { profile?: Record<string, unknown>; kyc?: Record<string, unknown> | null; visits?: Record<string, unknown>[]; skills?: Record<string, unknown>[] } = {}) {
  const profile = {
    id: 'profile-1',
    userId,
    onboardingStatus: OnboardingStatus.SUBMITTED,
    verificationStatus: VerificationStatus.PENDING,
    onboardingStep: 5,
    identityVerifiedAt: null,
    profileReviewRejectionReason: null,
    ...over.profile,
  };
  const skills = over.skills ?? [];
  const profileRepo = { findOne: vi.fn().mockResolvedValue(profile), save: vi.fn(async (p) => p) };
  const skillRepo = {
    count: vi.fn().mockResolvedValue(skills.length),
    find: vi.fn().mockResolvedValue(skills),
    remove: vi.fn(),
    save: vi.fn(async (s) => s),
    create: vi.fn((s) => s),
  };
  const serviceRepo = {
    createQueryBuilder: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([{ id: 'svc-1' }, { id: 'svc-2' }]),
    })),
  };
  const service = new TechnicianOnboardingService(
    profileRepo as never,
    skillRepo as never,
    { find: vi.fn().mockResolvedValue([]) } as never,
    { findOne: vi.fn().mockResolvedValue({ id: userId, role: Role.TECHNICIAN, dateOfBirth: '1990-01-01', gender: 'male', citizenIdNumber: '079203001234' }) } as never,
    serviceRepo as never,
    { findOne: vi.fn().mockResolvedValue(over.kyc === undefined ? null : over.kyc) } as never,
    { find: vi.fn().mockResolvedValue(over.visits ?? []) } as never,
    { getInt: vi.fn().mockResolvedValue(2), getString: vi.fn().mockResolvedValue('') } as never,
  );
  return { service, profile, profileRepo, skillRepo };
}

describe('technician onboarding review stages', () => {
  it('a verified KYC alone is the identity step: not approved yet, invited to book the office visit', async () => {
    const { service, profile, profileRepo } = build({ kyc: { status: VerificationStatus.VERIFIED, reviewedAt: new Date('2026-11-09T01:00:00Z') } });
    const status = await service.getOnboardingStatus(userId);
    expect(status.onboardingStatus).toBe(OnboardingStatus.SUBMITTED);
    expect(status.verificationStatus).toBe(VerificationStatus.PENDING);
    expect(status.reviewStage).toBe('visit_required');
    expect(profile.identityVerifiedAt).toBeInstanceOf(Date);
    expect(profileRepo.save).toHaveBeenCalled();
  });

  it('only the profile review (profile verified) makes the technician approved', async () => {
    const { service } = build({ profile: { verificationStatus: VerificationStatus.VERIFIED, onboardingStatus: OnboardingStatus.SUBMITTED } });
    const status = await service.getOnboardingStatus(userId);
    expect(status.onboardingStatus).toBe(OnboardingStatus.APPROVED);
    expect(status.reviewStage).toBe('approved');
  });

  it('reports the scheduled visit and the profile rejection reason separately from the identity result', async () => {
    const visit = { id: 'v1', officeId: 'o1', office: { name: 'Trụ sở Quận 1', address: '12 Lê Lợi' }, scheduledAt: new Date('2026-11-10T07:00:00Z'), status: 'scheduled' };
    const scheduled = build({ profile: { identityVerifiedAt: new Date() }, kyc: { status: VerificationStatus.VERIFIED }, visits: [visit] });
    const a = await scheduled.service.getOnboardingStatus(userId);
    expect(a.reviewStage).toBe('visit_scheduled');
    expect(a.officeVisit).toMatchObject({ officeName: 'Trụ sở Quận 1', scheduledAt: '2026-11-10T07:00:00.000Z' });

    const rejected = build({
      profile: { identityVerifiedAt: new Date(), onboardingStatus: OnboardingStatus.REJECTED, profileReviewRejectionReason: 'Bằng không rõ' },
      kyc: { status: VerificationStatus.VERIFIED },
    });
    const b = await rejected.service.getOnboardingStatus(userId);
    expect(b.reviewStage).toBe('profile_rejected');
    expect(b.rejectionReason).toBe('Bằng không rõ');
  });

  it('shows the support phone only once the technician is blocked by missed visits', async () => {
    const missed = { id: 'm', officeId: 'o1', scheduledAt: new Date(), status: 'missed', office: null };
    const { service } = build({ profile: { identityVerifiedAt: new Date() }, kyc: { status: VerificationStatus.VERIFIED }, visits: [missed, { ...missed, id: 'm2' }] });
    const status = await service.getOnboardingStatus(userId);
    expect(status.reviewStage).toBe('visit_blocked');
  });
});

describe('technician onboarding declared skill levels', () => {
  const dto = (extra: object = {}) => ({ serviceIds: ['svc-1', 'svc-2'], yearsExperience: 3, ...extra });

  it('stores the declared level on new skills and defaults to INTERMEDIATE', async () => {
    const { service, skillRepo } = build({ profile: { onboardingStatus: OnboardingStatus.IN_PROGRESS, onboardingStep: 3 } });
    await service.saveSkills(userId, dto({ skills: [{ serviceId: 'svc-1', level: 'EXPERT' }] }) as never);
    const created = skillRepo.create.mock.calls.map((c) => c[0]);
    expect(created).toContainEqual(expect.objectContaining({ serviceId: 'svc-1', level: 'EXPERT', declaredLevel: 'EXPERT' }));
    expect(created).toContainEqual(expect.objectContaining({ serviceId: 'svc-2', level: 'INTERMEDIATE', declaredLevel: null }));
  });

  it('refuses a level for a service that is not selected', async () => {
    const { service } = build({ profile: { onboardingStatus: OnboardingStatus.IN_PROGRESS } });
    await expect(service.saveSkills(userId, dto({ skills: [{ serviceId: 'other', level: 'ADVANCED' }] }) as never)).rejects.toThrow(BadRequestException);
  });

  it('keeps a confirmed level when the technician edits their declaration', async () => {
    const confirmed = { id: 's1', serviceId: 'svc-1', level: 'ADVANCED', declaredLevel: 'BEGINNER', verificationStatus: VerificationStatus.VERIFIED };
    const waiting = { id: 's2', serviceId: 'svc-2', level: 'INTERMEDIATE', declaredLevel: null, verificationStatus: VerificationStatus.PENDING };
    const { service } = build({ profile: { onboardingStatus: OnboardingStatus.IN_PROGRESS }, skills: [confirmed, waiting] });
    await service.saveSkills(userId, dto({ skills: [{ serviceId: 'svc-1', level: 'EXPERT' }, { serviceId: 'svc-2', level: 'EXPERT' }] }) as never);
    expect(confirmed.level).toBe('ADVANCED');
    expect(waiting.level).toBe('EXPERT');
    expect(waiting.declaredLevel).toBe('EXPERT');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AccountStatus, OnboardingStatus, Role, VerificationStatus } from '../../shared/enums';
import { TechnicianOnboardingService } from './technician-onboarding.service';

const technicianId = 'tech-1';

function build(notifications: { createManyNotifications: ReturnType<typeof vi.fn> } | undefined) {
  const profile = { id: 'p1', userId: technicianId, onboardingStatus: OnboardingStatus.IN_PROGRESS };
  const userRepo = {
    findOne: vi.fn().mockResolvedValue({ id: technicianId, fullName: 'Thợ Thử' }),
    find: vi.fn().mockResolvedValue([{ id: 'sm-1' }, { id: 'sm-2' }]),
  };
  const service = new TechnicianOnboardingService(
    { findOne: vi.fn().mockResolvedValue(profile), save: vi.fn(async (p) => p) } as never,
    {} as never,
    {} as never,
    userRepo as never,
    {} as never,
    { findOne: vi.fn().mockResolvedValue({ status: VerificationStatus.PENDING }) } as never,
    undefined,
    undefined,
    undefined,
    notifications as never,
  );
  vi.spyOn(service, 'getOnboardingStatus').mockResolvedValue({
    personalInfoCompleted: true, kycSubmitted: true, skillsSelected: true, addressSet: true,
  } as never);
  return { service, userRepo, profile };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('submitting the onboarding tells the service managers', () => {
  it('notifies every active service manager, naming the technician', async () => {
    const createManyNotifications = vi.fn().mockResolvedValue([]);
    const { service, userRepo, profile } = build({ createManyNotifications });
    await service.submitOnboarding(technicianId);
    await flush();
    expect(profile.onboardingStatus).toBe(OnboardingStatus.SUBMITTED);
    expect(userRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { role: Role.SERVICE_MANAGER, isActive: true, status: AccountStatus.ACTIVE } }));
    expect(createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'sm-1', type: 'TECHNICIAN_PROFILE_SUBMITTED', referenceId: technicianId, message: expect.stringContaining('Thợ Thử') }),
      expect.objectContaining({ userId: 'sm-2' }),
    ]);
  });

  it('still submits when the notice cannot be written, or when there is no notification service', async () => {
    const failing = build({ createManyNotifications: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(failing.service.submitOnboarding(technicianId)).resolves.toBeDefined();
    await flush();
    expect(failing.profile.onboardingStatus).toBe(OnboardingStatus.SUBMITTED);
    const bare = build(undefined);
    await expect(bare.service.submitOnboarding(technicianId)).resolves.toBeDefined();
  });
});

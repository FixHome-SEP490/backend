import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TechnicianOnboardingService } from './technician-onboarding.service';
import { OnboardingStatus, VerificationStatus } from '../../shared/enums';

const userId = 'user-1';
const info = {
  fullName: 'Le Quoc Bao',
  dateOfBirth: '1992-03-15',
  gender: 'male',
  citizenIdNumber: '079092012345',
  phoneNumber: '0901000102',
};

function build(over: { onboardingStatus?: OnboardingStatus; kyc?: { status: VerificationStatus } | null; phoneOwner?: { id: string } | null; updateError?: unknown } = {}) {
  const profile = {
    id: 'profile-1',
    userId,
    onboardingStatus: over.onboardingStatus ?? OnboardingStatus.IN_PROGRESS,
    verificationStatus: VerificationStatus.PENDING,
    onboardingStep: 1,
  };
  const userRepo = {
    // Citizen id lookup returns nothing; phone lookup returns the configured owner.
    findOne: vi.fn(async ({ where }: { where: Record<string, string> }) => (where.phoneNumber ? (over.phoneOwner ?? null) : null)),
    update: vi.fn(async () => {
      if (over.updateError) throw over.updateError;
    }),
  };
  const service = new TechnicianOnboardingService(
    { findOne: vi.fn().mockResolvedValue(profile), save: vi.fn(async (p) => p) } as never,
    {} as never,
    {} as never,
    userRepo as never,
    {} as never,
    { findOne: vi.fn().mockResolvedValue(over.kyc ?? null) } as never,
  );
  vi.spyOn(service, 'getOnboardingStatus').mockResolvedValue({} as never);
  return { service, userRepo };
}

describe('technician onboarding edit guards', () => {
  it('refuses any edit while the profile waits for review', async () => {
    const { service, userRepo } = build({ onboardingStatus: OnboardingStatus.SUBMITTED });
    await expect(service.savePersonalInfo(userId, info as never)).rejects.toThrow(BadRequestException);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it.each([VerificationStatus.PENDING, VerificationStatus.VERIFIED])('locks personal info once identity papers are %s', async (status) => {
    const { service, userRepo } = build({ kyc: { status } });
    await expect(service.savePersonalInfo(userId, info as never)).rejects.toThrow(/không thể thay đổi/);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('allows editing again after the identity papers were rejected', async () => {
    const { service, userRepo } = build({ kyc: { status: VerificationStatus.REJECTED } });
    await service.savePersonalInfo(userId, info as never);
    expect(userRepo.update).toHaveBeenCalled();
  });

  it('rejects a phone number that belongs to another account', async () => {
    const { service, userRepo } = build({ phoneOwner: { id: 'someone-else' } });
    await expect(service.savePersonalInfo(userId, info as never)).rejects.toThrow(/Số điện thoại/);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('turns a unique-index race into a 400 instead of a 500', async () => {
    const { service } = build({ updateError: { code: '23505' } });
    await expect(service.savePersonalInfo(userId, info as never)).rejects.toThrow(BadRequestException);
  });
});

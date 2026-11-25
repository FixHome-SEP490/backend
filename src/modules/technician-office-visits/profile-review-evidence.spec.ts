import { describe, expect, it, vi } from 'vitest';
import { OnboardingStatus, VerificationStatus } from '../../shared/enums';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { ProfileReviewService } from './profile-review.service';

const doc = (id: string, path: string, extra: object = {}) => ({ id, storageObjectPath: path, fileName: `${id}.jpg`, mimeType: 'image/jpeg', evidenceType: 'social_insurance', issuer: 'BHXH', ...extra });
const skill = (id: string, categoryId: string, categoryName: string) => ({
  id, level: 'INTERMEDIATE', declaredLevel: 'INTERMEDIATE', verificationStatus: VerificationStatus.PENDING,
  service: { name: `Dịch vụ ${id}`, categoryId, category: { name: categoryName } },
});

function harness(requests: object[]) {
  const profile = {
    id: 'p1', userId: 't1', user: { fullName: 'Thợ', email: 't@x.vn' }, yearsExperience: 3, serviceRadiusKm: 10, serviceAreas: [],
    onboardingStatus: OnboardingStatus.SUBMITTED, verificationStatus: VerificationStatus.PENDING, identityVerifiedAt: new Date(),
    skills: [skill('s1', 'c1', 'Điều hòa'), skill('s2', 'c1', 'Điều hòa'), skill('s3', 'c2', 'Tủ lạnh')],
  };
  const requestRepo = { find: vi.fn().mockResolvedValue(requests) };
  const manager = { getRepository: (entity: unknown) => (entity === TechnicianSkillVerification ? requestRepo : undefined) };
  const service = new ProfileReviewService(
    { manager, findOne: vi.fn().mockResolvedValue(profile) } as never,
    { find: vi.fn().mockResolvedValue([]) } as never,
    { findOne: vi.fn().mockResolvedValue(null) } as never,
    { getInt: vi.fn().mockResolvedValue(2) } as never,
    {} as never,
  );
  return { service, requestRepo };
}

describe('ProfileReviewService.get: skills and papers', () => {
  it('names the category of every skill', async () => {
    const { service } = harness([]);
    const result = await service.get('t1');
    expect(result.skills.map((s) => [s.id, s.categoryId, s.categoryName])).toEqual([['s1', 'c1', 'Điều hòa'], ['s2', 'c1', 'Điều hòa'], ['s3', 'c2', 'Tủ lạnh']]);
    expect(result.evidence).toEqual([]);
  });

  it('folds the rows of one stored paper into one entry that lists the skills it covers', async () => {
    const { service, requestRepo } = harness([
      { id: 'r1', technicianSkillId: 's1', documents: [doc('d1', 'kyc/a.jpg', { claimedYears: 5 })] },
      { id: 'r2', technicianSkillId: 's2', documents: [doc('d2', 'kyc/a.jpg', { claimedYears: 5 })] },
      { id: 'r3', technicianSkillId: 's3', documents: [doc('d3', 'kyc/b.jpg')] },
    ]);
    const { evidence } = await service.get('t1');
    expect(requestRepo.find).toHaveBeenCalledWith(expect.objectContaining({ relations: ['documents'] }));
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ verificationId: 'r1', documentId: 'd1', evidenceType: 'social_insurance', issuer: 'BHXH', claimedYears: 5, skillIds: ['s1', 's2'] });
    expect(evidence[1]).toMatchObject({ documentId: 'd3', skillIds: ['s3'] });
    expect(JSON.stringify(evidence)).not.toContain('kyc/');
  });
});

// src/modules/technician-skill-verifications/technician-skill-verifications.service.spec.ts
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SKILL_EVIDENCE_NOT_UPLOADED,
  TechnicianSkillVerificationsService,
  skillEvidenceMetadata,
} from './technician-skill-verifications.service';
import {
  SKILL_EVIDENCE_GROUP_BY_TYPE,
  SKILL_EVIDENCE_TYPES,
  SkillEvidenceGroup,
  SkillEvidenceReviewStatus,
  SkillEvidenceType,
  VerificationStatus,
} from '../../shared/enums';

const TECH_USER = 'tech-user-1';
const SERVICE_ID = 'service-1';
const VERIFICATION_ID = 'skill-verif-1';

describe('TechnicianSkillVerificationsService evidence must be really uploaded', () => {
  let service: TechnicianSkillVerificationsService;
  let verificationRepo: any;
  let skillRepo: any;
  let profileRepo: any;
  let documentRepo: any;
  let storage: any;
  let uploaded: Set<string>;

  const evidence = (storageObjectPath: string) => ({
    storageObjectPath,
    fileName: 'chung-chi.jpg',
    fileSize: 2048,
    mimeType: 'image/jpeg',
  });

  beforeEach(() => {
    uploaded = new Set();
    const pending = {
      id: VERIFICATION_ID,
      technicianSkillId: 'skill-1',
      status: VerificationStatus.PENDING,
      technicianSkill: { technician: { userId: TECH_USER } },
    };
    verificationRepo = {
      findOne: vi.fn().mockResolvedValue(pending),
      manager: { transaction: vi.fn() },
    };
    skillRepo = { findOne: vi.fn().mockResolvedValue({ id: 'skill-1' }) };
    profileRepo = { findOne: vi.fn().mockResolvedValue({ id: 'profile-1', userId: TECH_USER }) };
    documentRepo = {
      create: vi.fn((doc) => doc),
      save: vi.fn(async (doc) => ({ id: 'doc-1', ...doc })),
    };
    storage = {
      validateObjectPath: vi.fn((path: string, owner: string) => {
        if (!path.startsWith(`kyc/${owner}/`)) {
          throw new BadRequestException('storageObjectPath must belong to the technician KYC prefix');
        }
      }),
      objectExists: vi.fn(async (path: string) => uploaded.has(path)),
    };
    service = new TechnicianSkillVerificationsService(
      verificationRepo,
      skillRepo,
      profileRepo,
      documentRepo,
      { logWithManagerStrict: vi.fn() } as any,
      storage,
    );
    vi.spyOn(service, 'findById').mockResolvedValue({ id: VERIFICATION_ID } as any);
  });

  it('refuses a path in the own folder that was never uploaded and saves nothing', async () => {
    const ghost = `kyc/${TECH_USER}/never-uploaded.jpg`;
    await expect(service.attachEvidence(TECH_USER, SERVICE_ID, evidence(ghost))).rejects.toThrow(
      SKILL_EVIDENCE_NOT_UPLOADED,
    );
    expect(storage.objectExists).toHaveBeenCalledWith(ghost, TECH_USER);
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it("refuses another technician's path before asking storage", async () => {
    const theirs = 'kyc/tech-user-2/uploaded.jpg';
    uploaded.add(theirs);
    await expect(service.attachEvidence(TECH_USER, SERVICE_ID, evidence(theirs))).rejects.toThrow(
      'technician KYC prefix',
    );
    expect(storage.objectExists).not.toHaveBeenCalled();
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it('saves nothing when storage cannot be checked', async () => {
    storage.objectExists.mockRejectedValue(new ServiceUnavailableException('Private KYC storage could not be checked'));
    await expect(
      service.attachEvidence(TECH_USER, SERVICE_ID, evidence(`kyc/${TECH_USER}/a.jpg`)),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it('does not ask storage when the skill has no pending request', async () => {
    verificationRepo.findOne.mockResolvedValue(null);
    const path = `kyc/${TECH_USER}/a.jpg`;
    uploaded.add(path);
    await expect(service.attachEvidence(TECH_USER, SERVICE_ID, evidence(path))).rejects.toThrow(
      ConflictException,
    );
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it('attaches an uploaded file as a certificate document', async () => {
    const path = `kyc/${TECH_USER}/real.jpg`;
    uploaded.add(path);
    await expect(service.attachEvidence(TECH_USER, SERVICE_ID, evidence(path))).resolves.toEqual({
      id: VERIFICATION_ID,
    });
    expect(documentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ skillVerificationId: VERIFICATION_ID, storageObjectPath: path, issuedById: null }),
    );
  });

  it('stores the evidence metadata with the group derived from the type', async () => {
    const path = `kyc/${TECH_USER}/with-meta.jpg`;
    uploaded.add(path);
    await service.attachEvidence(TECH_USER, SERVICE_ID, {
      ...evidence(path),
      evidenceType: SkillEvidenceType.NATIONAL_SKILL_CERTIFICATE,
      issuer: 'Trường Cao đẳng nghề',
      issuedAt: '2021-06-15',
      expiresAt: '2027-06-15',
      claimedYears: 5,
    });
    expect(documentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: SkillEvidenceType.NATIONAL_SKILL_CERTIFICATE,
        evidenceGroup: SkillEvidenceGroup.OFFICIAL,
        issuer: 'Trường Cao đẳng nghề',
        issuedAt: '2021-06-15',
        claimedYears: 5,
        reviewStatus: SkillEvidenceReviewStatus.PENDING,
      }),
    );
  });

  it('refuses bad metadata before asking storage or saving', async () => {
    const path = `kyc/${TECH_USER}/bad-meta.jpg`;
    uploaded.add(path);
    await expect(
      service.attachEvidence(TECH_USER, SERVICE_ID, { ...evidence(path), issuer: 'Ai đó' }),
    ).rejects.toThrow(BadRequestException);
    expect(storage.objectExists).not.toHaveBeenCalled();
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it('refuses to approve with an issued certificate that was never uploaded', async () => {
    const ghost = `kyc/${TECH_USER}/certificate.jpg`;
    await expect(service.approve(VERIFICATION_ID, 'admin-1', evidence(ghost))).rejects.toThrow(
      SKILL_EVIDENCE_NOT_UPLOADED,
    );
    expect(storage.objectExists).toHaveBeenCalledWith(ghost, TECH_USER);
    expect(verificationRepo.manager.transaction).not.toHaveBeenCalled();
  });
});

describe('skillEvidenceMetadata', () => {
  const base = { storageObjectPath: 'p', fileName: 'a.jpg', fileSize: 1, mimeType: 'image/jpeg' };

  it('stores nothing extra when the client sends only the file', () => {
    expect(skillEvidenceMetadata(base)).toEqual({});
  });

  it('refuses details without an evidence type', () => {
    expect(() => skillEvidenceMetadata({ ...base, claimedYears: 0 })).toThrow(BadRequestException);
    expect(() => skillEvidenceMetadata({ ...base, referenceNumber: 'X1' })).toThrow(BadRequestException);
  });

  it('maps every evidence type to a trust group', () => {
    expect(Object.keys(SKILL_EVIDENCE_GROUP_BY_TYPE).sort()).toEqual([...SKILL_EVIDENCE_TYPES].sort());
    expect(skillEvidenceMetadata({ ...base, evidenceType: SkillEvidenceType.EMPLOYER_CONFIRMATION }).evidenceGroup).toBe(
      SkillEvidenceGroup.VERIFIABLE,
    );
    expect(skillEvidenceMetadata({ ...base, evidenceType: SkillEvidenceType.WORK_PHOTOS }).evidenceGroup).toBe(
      SkillEvidenceGroup.SELF_DECLARED,
    );
  });

  it('refuses an expiry before the issue date and dates that do not exist', () => {
    const type = SkillEvidenceType.VOCATIONAL_DIPLOMA;
    expect(() =>
      skillEvidenceMetadata({ ...base, evidenceType: type, issuedAt: '2024-05-02', expiresAt: '2024-05-01' }),
    ).toThrow(BadRequestException);
    expect(() => skillEvidenceMetadata({ ...base, evidenceType: type, issuedAt: '2021-02-31' })).toThrow(
      BadRequestException,
    );
    expect(skillEvidenceMetadata({ ...base, evidenceType: type, issuedAt: '2024-05-01', expiresAt: '2024-05-01' }))
      .toMatchObject({ reviewStatus: SkillEvidenceReviewStatus.PENDING });
  });
});

describe('TechnicianSkillVerificationsService.findAll lists only skills added after the profile was approved', () => {
  it('keeps the requests of technicians still in onboarding out of the list', async () => {
    const qb: any = {};
    for (const method of ['leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take']) qb[method] = vi.fn(() => qb);
    qb.getManyAndCount = vi.fn().mockResolvedValue([[], 0]);
    const service = new TechnicianSkillVerificationsService(
      { createQueryBuilder: () => qb } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    await service.findAll({ page: 1, limit: 10, skip: 0 } as any);
    expect(qb.andWhere).toHaveBeenCalledWith('profile.verificationStatus = :approved', { approved: VerificationStatus.VERIFIED });
  });
});

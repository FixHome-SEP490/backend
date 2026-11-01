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
} from './technician-skill-verifications.service';
import { VerificationStatus } from '../../shared/enums';

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

  it('refuses to approve with an issued certificate that was never uploaded', async () => {
    const ghost = `kyc/${TECH_USER}/certificate.jpg`;
    await expect(service.approve(VERIFICATION_ID, 'admin-1', evidence(ghost))).rejects.toThrow(
      SKILL_EVIDENCE_NOT_UPLOADED,
    );
    expect(storage.objectExists).toHaveBeenCalledWith(ghost, TECH_USER);
    expect(verificationRepo.manager.transaction).not.toHaveBeenCalled();
  });
});

// src/modules/technician-skill-verifications/technician-skill-evidence-categories.spec.ts
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SKILL_EVIDENCE_NOT_UPLOADED, TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { SkillEvidenceGroup, SkillEvidenceReviewStatus, SkillEvidenceType, VerificationStatus } from '../../shared/enums';

const TECH_USER = 'tech-user-1';
const PATH = `kyc/${TECH_USER}/bang-dien-lanh.jpg`;

describe('TechnicianSkillVerificationsService.attachEvidenceToCategories', () => {
  let service: TechnicianSkillVerificationsService;
  let skills: any[];
  let skillRepo: any;
  let verificationRepo: any;
  let documentRepo: any;
  let storage: any;
  let uploaded: Set<string>;

  const dto = (extra: object = {}) => ({
    storageObjectPath: PATH,
    fileName: 'bang-dien-lanh.jpg',
    fileSize: 2048,
    mimeType: 'image/jpeg',
    categoryIds: ['cat-ac', 'cat-fridge'],
    evidenceType: SkillEvidenceType.VOCATIONAL_DIPLOMA,
    issuer: 'Trường nghề',
    ...extra,
  });

  beforeEach(() => {
    uploaded = new Set([PATH]);
    skills = [
      { id: 'sk-ac', serviceId: 'svc-ac', isActive: true, verificationStatus: VerificationStatus.PENDING },
      { id: 'sk-fridge', serviceId: 'svc-fridge', isActive: true, verificationStatus: VerificationStatus.PENDING },
      { id: 'sk-done', serviceId: 'svc-done', isActive: true, verificationStatus: VerificationStatus.VERIFIED },
    ];
    skillRepo = { find: vi.fn(async () => skills) };
    verificationRepo = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((v) => v),
      save: vi.fn(async (v) => ({ id: `req-${v.technicianSkillId}`, ...v })),
    };
    documentRepo = { create: vi.fn((d) => d), save: vi.fn(async (d) => d), find: vi.fn().mockResolvedValue([]) };
    storage = {
      validateObjectPath: vi.fn((path: string, owner: string) => {
        if (!path.startsWith(`kyc/${owner}/`)) throw new BadRequestException('storageObjectPath must belong to the technician KYC prefix');
      }),
      objectExists: vi.fn(async (path: string) => uploaded.has(path)),
    };
    service = new TechnicianSkillVerificationsService(
      verificationRepo,
      skillRepo,
      { findOne: vi.fn().mockResolvedValue({ id: 'profile-1', userId: TECH_USER }) } as any,
      documentRepo,
      { logWithManagerStrict: vi.fn(), log: vi.fn() } as any,
      storage,
    );
  });

  it('writes one document per waiting skill, all pointing at the same file, and skips a confirmed skill', async () => {
    await expect(service.attachEvidenceToCategories(TECH_USER, dto() as any)).resolves.toEqual({
      attachedSkills: 2,
      serviceIds: ['svc-ac', 'svc-fridge'],
    });
    expect(skillRepo.find).toHaveBeenCalledWith({
      where: expect.objectContaining({ technicianId: 'profile-1', isActive: true }),
      relations: ['service'],
    });
    const rows = documentRepo.save.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.skillVerificationId)).toEqual(['req-sk-ac', 'req-sk-fridge']);
    for (const row of rows) {
      expect(row).toMatchObject({
        storageObjectPath: PATH,
        issuedById: null,
        evidenceType: SkillEvidenceType.VOCATIONAL_DIPLOMA,
        evidenceGroup: SkillEvidenceGroup.OFFICIAL,
        issuer: 'Trường nghề',
        reviewStatus: SkillEvidenceReviewStatus.PENDING,
      });
    }
    expect(storage.objectExists).toHaveBeenCalledTimes(1);
  });

  it('reuses a pending request instead of opening a new one', async () => {
    verificationRepo.findOne.mockImplementation(async ({ where }: any) => ({ id: `old-${where.technicianSkillId}` }));
    await service.attachEvidenceToCategories(TECH_USER, dto() as any);
    expect(verificationRepo.save).not.toHaveBeenCalled();
    expect(documentRepo.save.mock.calls[0][0].map((r: any) => r.skillVerificationId)).toEqual(['old-sk-ac', 'old-sk-fridge']);
  });

  it('is a 404 when no skill of the technician waits in those categories, and saves nothing', async () => {
    skills = [skills[2]];
    await expect(service.attachEvidenceToCategories(TECH_USER, dto() as any)).rejects.toThrow(NotFoundException);
    skills = [];
    await expect(service.attachEvidenceToCategories(TECH_USER, dto() as any)).rejects.toThrow(NotFoundException);
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it('refuses a file that was never uploaded before opening any request', async () => {
    uploaded.clear();
    await expect(service.attachEvidenceToCategories(TECH_USER, dto() as any)).rejects.toThrow(SKILL_EVIDENCE_NOT_UPLOADED);
    expect(verificationRepo.save).not.toHaveBeenCalled();
    expect(documentRepo.save).not.toHaveBeenCalled();
  });

  it("refuses another technician's path and details without a type before touching storage", async () => {
    await expect(
      service.attachEvidenceToCategories(TECH_USER, dto({ storageObjectPath: 'kyc/tech-user-2/x.jpg' }) as any),
    ).rejects.toThrow('technician KYC prefix');
    await expect(
      service.attachEvidenceToCategories(TECH_USER, dto({ evidenceType: undefined }) as any),
    ).rejects.toThrow(BadRequestException);
    expect(storage.objectExists).not.toHaveBeenCalled();
    expect(documentRepo.save).not.toHaveBeenCalled();
  });
});

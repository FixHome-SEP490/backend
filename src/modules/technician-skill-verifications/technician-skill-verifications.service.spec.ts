// src/modules/technician-skill-verifications/technician-skill-verifications.service.spec.ts
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
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

describe('TechnicianSkillVerificationsService.listMyEvidence', () => {
  const doc = (id: string, path: string, at: number, extra: object = {}) => ({
    id, storageObjectPath: path, fileName: `${id}.jpg`, mimeType: 'image/jpeg', issuedById: null, createdAt: new Date(at), evidenceType: 'social_insurance', issuer: 'BHXH', ...extra,
  });
  const request = (serviceId: string, categoryId: string, categoryName: string, documents: object[], over: { status?: string; skillStatus?: string } = {}) => ({
    status: over.status ?? 'pending',
    technicianSkill: { serviceId, verificationStatus: over.skillStatus ?? 'pending', service: { categoryId, category: { name: categoryName } } }, documents,
  });
  const build = (requests: object[], onboardingStatus = 'approved') =>
    new TechnicianSkillVerificationsService(
      { find: vi.fn().mockResolvedValue(requests) } as any,
      {} as any,
      { findOne: vi.fn().mockResolvedValue({ id: 'p1', onboardingStatus }) } as any,
      {} as any, {} as any, {} as any,
    );

  it('folds the rows of one stored paper into one entry that names the categories it covers, oldest first', async () => {
    const service = build([
      request('s-ac', 'c-ac', 'Điều hòa', [doc('d1', 'kyc/a.jpg', 2000)]),
      request('s-fr', 'c-fr', 'Tủ lạnh', [doc('d2', 'kyc/a.jpg', 2000), doc('d3', 'kyc/b.jpg', 1000)]),
    ]);
    const list = await service.listMyEvidence('u1');
    expect(list.map((e) => e.documentId)).toEqual(['d3', 'd1']);
    expect(list[1]).toMatchObject({ serviceId: 's-ac', evidenceType: 'social_insurance', issuer: 'BHXH', categories: [{ id: 'c-ac', name: 'Điều hòa' }, { id: 'c-fr', name: 'Tủ lạnh' }] });
    expect(JSON.stringify(list)).not.toContain('kyc/');
  });

  it('marks a paper locked once its skills were reviewed, or while the profile waits for review', async () => {
    const reviewed = build([request('s-ac', 'c-ac', 'Điều hòa', [doc('d1', 'kyc/a.jpg', 1)], { status: 'verified', skillStatus: 'verified' })]);
    expect((await reviewed.listMyEvidence('u1'))[0].editable).toBe(false);
    const mixed = build([
      request('s-ac', 'c-ac', 'Điều hòa', [doc('d1', 'kyc/a.jpg', 1)], { status: 'verified', skillStatus: 'verified' }),
      request('s-fr', 'c-fr', 'Tủ lạnh', [doc('d2', 'kyc/a.jpg', 1)]),
    ]);
    expect((await mixed.listMyEvidence('u1'))[0].editable).toBe(true);
    const inReview = build([request('s-ac', 'c-ac', 'Điều hòa', [doc('d1', 'kyc/a.jpg', 1)])], 'submitted');
    expect((await inReview.listMyEvidence('u1'))[0].editable).toBe(false);
  });

  it('leaves out the certificate FixHome issued, and answers an empty list without a profile', async () => {
    const issued = build([request('s-ac', 'c-ac', 'Điều hòa', [doc('d1', 'kyc/a.jpg', 1, { issuedById: 'admin-1' })])]);
    await expect(issued.listMyEvidence('u1')).resolves.toEqual([]);
    const noProfile = new TechnicianSkillVerificationsService({} as any, {} as any, { findOne: vi.fn().mockResolvedValue(null) } as any, {} as any, {} as any, {} as any);
    await expect(noProfile.listMyEvidence('u1')).resolves.toEqual([]);
  });
});

describe('TechnicianSkillVerificationsService.deleteMyEvidence / updateMyEvidence', () => {
  const row = (id: string, skillId: string, categoryId: string, over: { requestStatus?: VerificationStatus; skillStatus?: VerificationStatus; technicianId?: string } = {}) => ({
    id, storageObjectPath: 'kyc/u1/a.jpg', fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg', issuedById: null,
    skillVerification: {
      id: `rq-${skillId}`, technicianSkillId: skillId, status: over.requestStatus ?? VerificationStatus.PENDING,
      technicianSkill: { id: skillId, technicianId: over.technicianId ?? 'p1', verificationStatus: over.skillStatus ?? VerificationStatus.PENDING, service: { categoryId } },
    },
  });

  function harness(rows: ReturnType<typeof row>[], opts: { onboardingStatus?: string; remaining?: number; skills?: object[] } = {}) {
    const documentRepo = {
      findOne: vi.fn().mockResolvedValue(rows[0]),
      find: vi.fn().mockResolvedValue(rows),
      remove: vi.fn(async (r) => r),
      count: vi.fn().mockResolvedValue(opts.remaining ?? 0),
      update: vi.fn(),
      save: vi.fn(),
      create: vi.fn((v) => v),
    };
    const storage = { remove: vi.fn() };
    const verificationRepo = { findOne: vi.fn().mockResolvedValue({ id: 'rq-new' }), find: vi.fn().mockResolvedValue([]) };
    const skillRepo = { find: vi.fn().mockResolvedValue(opts.skills ?? []) };
    const profileRepo = { findOne: vi.fn().mockResolvedValue({ id: 'p1', onboardingStatus: opts.onboardingStatus ?? 'in_progress' }) };
    const service = new TechnicianSkillVerificationsService(verificationRepo as any, skillRepo as any, profileRepo as any, documentRepo as any, {} as any, storage as any);
    return { service, documentRepo, storage };
  }

  it('removes the paper from every skill it sits on, and the stored file once nothing points at it', async () => {
    const { service, documentRepo, storage } = harness([row('d1', 's1', 'c1'), row('d2', 's2', 'c2')]);
    await expect(service.deleteMyEvidence('u1', 'd1')).resolves.toEqual({ removed: 2 });
    expect(documentRepo.remove).toHaveBeenCalledWith([expect.objectContaining({ id: 'd1' }), expect.objectContaining({ id: 'd2' })]);
    expect(storage.remove).toHaveBeenCalledWith(['kyc/u1/a.jpg']);
  });

  it('keeps the stored file while another row still points at it', async () => {
    const { service, storage } = harness([row('d1', 's1', 'c1')], { remaining: 1 });
    await service.deleteMyEvidence('u1', 'd1');
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('refuses a paper whose skills are all confirmed, a paper of someone else, and a technician waiting for the review', async () => {
    const confirmed = harness([row('d1', 's1', 'c1', { skillStatus: VerificationStatus.VERIFIED })]);
    await expect(confirmed.service.deleteMyEvidence('u1', 'd1')).rejects.toBeInstanceOf(ConflictException);
    const foreign = harness([row('d1', 's1', 'c1', { technicianId: 'other' })]);
    await expect(foreign.service.deleteMyEvidence('u1', 'd1')).rejects.toThrow('Verification document not found');
    const waiting = harness([row('d1', 's1', 'c1')], { onboardingStatus: 'submitted' });
    await expect(waiting.service.deleteMyEvidence('u1', 'd1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('changes the details of the kept rows, drops the rows of a category taken off, and adds the ones of a category added', async () => {
    const skills = [
      { id: 's1', verificationStatus: VerificationStatus.PENDING, isActive: true },
      { id: 's3', verificationStatus: VerificationStatus.PENDING, isActive: true },
    ];
    const { service, documentRepo } = harness([row('d1', 's1', 'c1'), row('d2', 's2', 'c2')], { skills });
    vi.spyOn(service, 'listMyEvidence').mockResolvedValue([]);
    await service.updateMyEvidence('u1', 'd1', { categoryIds: ['c1', 'c3'], evidenceType: 'social_insurance', issuer: 'BHXH', claimedYears: 5 } as any);
    expect(documentRepo.remove).toHaveBeenCalledWith([expect.objectContaining({ id: 'd2' })]);
    expect(documentRepo.update).toHaveBeenCalledWith(['d1'], expect.objectContaining({ evidenceType: 'social_insurance', issuer: 'BHXH', claimedYears: 5, referenceNumber: null }));
    expect(documentRepo.save).toHaveBeenCalledWith([expect.objectContaining({ skillVerificationId: 'rq-new', storageObjectPath: 'kyc/u1/a.jpg', issuer: 'BHXH' })]);
  });

  it('needs at least one skill waiting in the categories left', async () => {
    const { service } = harness([row('d1', 's1', 'c1')], { skills: [] });
    await expect(service.updateMyEvidence('u1', 'd1', { categoryIds: ['c9'] } as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});

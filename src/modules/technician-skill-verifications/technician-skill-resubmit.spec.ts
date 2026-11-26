// src/modules/technician-skill-verifications/technician-skill-resubmit.spec.ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { Role, VerificationStatus } from '../../shared/enums';

const TECH = 'tech-user-1';

function build(over: { skill?: object | null; rows?: object[]; remaining?: number; uploaded?: boolean; history?: object[] } = {}) {
  const skillRow = over.skill === undefined
    ? { id: 's1', serviceId: 'svc-1', isActive: true, verificationStatus: VerificationStatus.REJECTED, service: { name: 'Sửa điều hòa' } }
    : over.skill;
  const skills = { update: vi.fn() };
  const documents = { create: vi.fn((v) => v), save: vi.fn(), update: vi.fn(), count: vi.fn().mockResolvedValue(over.remaining ?? 0), find: vi.fn().mockResolvedValue(over.rows ?? []), findOne: vi.fn().mockResolvedValue((over.rows ?? [])[0]), remove: vi.fn() };
  const verificationRepo = {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockResolvedValue(over.history ?? []),
    create: vi.fn((v) => v),
    save: vi.fn(async (v) => ({ id: 'rq-new', ...v })),
    manager: { getRepository: () => skills },
  };
  const notifications = { createManyNotifications: vi.fn(), createNotification: vi.fn().mockResolvedValue({}) };
  const userRepo = {
    findOne: vi.fn().mockResolvedValue({ id: TECH, fullName: 'Thợ Test' }),
    find: vi.fn().mockResolvedValue([{ id: 'sm-1' }, { id: 'sm-2' }]),
  };
  const audit = { log: vi.fn() };
  const storage = {
    validateObjectPath: vi.fn((path: string) => { if (!path.startsWith(`kyc/${TECH}/`)) throw new BadRequestException('storageObjectPath must belong to the technician KYC prefix'); }),
    objectExists: vi.fn(async () => over.uploaded ?? true),
    remove: vi.fn(),
  };
  const service = new TechnicianSkillVerificationsService(
    verificationRepo as any,
    { findOne: vi.fn().mockResolvedValue(skillRow), find: vi.fn().mockResolvedValue([]) } as any,
    { findOne: vi.fn().mockResolvedValue({ id: 'p1', onboardingStatus: 'approved' }) } as any,
    documents as any,
    audit as any,
    storage as any,
    notifications as any,
    userRepo as any,
  );
  vi.spyOn(service, 'findById').mockResolvedValue({ id: 'rq-new' } as any);
  return { service, skills, documents, verificationRepo, notifications, audit, storage, userRepo };
}

describe('TechnicianSkillVerificationsService.resubmitSkill', () => {
  it('opens a new request for a rejected skill, puts it back in review, tells the managers and traces it', async () => {
    const { service, skills, verificationRepo, notifications, audit } = build();
    await expect(service.resubmitSkill(TECH, 'svc-1')).resolves.toEqual({ id: 'rq-new' });
    expect(verificationRepo.save).toHaveBeenCalledTimes(1);
    expect(skills.update).toHaveBeenCalledWith('s1', { verificationStatus: VerificationStatus.PENDING });
    expect(notifications.createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'sm-1', type: 'SKILL_VERIFICATION_RESUBMITTED', referenceId: 'rq-new', message: expect.stringContaining('Sửa điều hòa') }),
      expect.objectContaining({ userId: 'sm-2' }),
    ]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SKILL_RESUBMITTED', actorRole: Role.TECHNICIAN }));
  });

  it('refuses a skill that was not rejected, one switched off, and a skill that is not the technician\'s', async () => {
    for (const verificationStatus of [VerificationStatus.PENDING, VerificationStatus.VERIFIED]) {
      const { service, verificationRepo } = build({ skill: { id: 's1', isActive: true, verificationStatus, service: { name: 'x' } } });
      await expect(service.resubmitSkill(TECH, 'svc-1')).rejects.toBeInstanceOf(ConflictException);
      expect(verificationRepo.save).not.toHaveBeenCalled();
    }
    const off = build({ skill: { id: 's1', isActive: false, verificationStatus: VerificationStatus.REJECTED, service: { name: 'x' } } });
    await expect(off.service.resubmitSkill(TECH, 'svc-1')).rejects.toBeInstanceOf(ConflictException);
    const missing = build({ skill: null });
    await expect(missing.service.resubmitSkill(TECH, 'svc-1')).rejects.toThrow('Skill not found');
  });

  it('still opens the request when the managers cannot be told', async () => {
    const { service, notifications } = build();
    notifications.createManyNotifications.mockRejectedValue(new Error('db down'));
    await expect(service.resubmitSkill(TECH, 'svc-1')).resolves.toEqual({ id: 'rq-new' });
  });
});

describe('TechnicianSkillVerificationsService.deleteMyEvidenceFromSkill takes a paper off one skill only', () => {
  const row = (over: { requestStatus?: VerificationStatus; skillStatus?: VerificationStatus; technicianId?: string; serviceId?: string; issuedById?: string | null } = {}) => ({
    id: 'd1', storageObjectPath: `kyc/${TECH}/a.jpg`, issuedById: over.issuedById ?? null, evidenceType: 'social_insurance',
    skillVerification: { id: 'rq1', status: over.requestStatus ?? VerificationStatus.PENDING, technicianSkill: { id: 's1', serviceId: over.serviceId ?? 'svc-1', technicianId: over.technicianId ?? 'p1', verificationStatus: over.skillStatus ?? VerificationStatus.PENDING } },
  });

  it('removes only that skill row, keeps the file while another skill still uses it, and traces it', async () => {
    const { service, documents, storage, audit } = build({ rows: [row()], remaining: 1 });
    await expect(service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1')).resolves.toEqual({ removed: 1 });
    expect(documents.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
    expect(storage.remove).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SKILL_EVIDENCE_DELETED' }));
  });

  it('removes the stored file once no skill uses it', async () => {
    const { service, storage } = build({ rows: [row({ requestStatus: VerificationStatus.REJECTED, skillStatus: VerificationStatus.REJECTED })], remaining: 0 });
    await service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1');
    expect(storage.remove).toHaveBeenCalledWith([`kyc/${TECH}/a.jpg`]);
  });

  it('refuses a paper that approved the skill, a paper of another skill or technician, and a certificate FixHome issued', async () => {
    const approved = build({ rows: [row({ requestStatus: VerificationStatus.VERIFIED, skillStatus: VerificationStatus.VERIFIED })] });
    await expect(approved.service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1')).rejects.toBeInstanceOf(ConflictException);
    const otherSkill = build({ rows: [row({ serviceId: 'svc-2' })] });
    await expect(otherSkill.service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1')).rejects.toThrow('Verification document not found');
    const foreign = build({ rows: [row({ technicianId: 'other' })] });
    await expect(foreign.service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1')).rejects.toThrow('Verification document not found');
    const issued = build({ rows: [row({ issuedById: 'admin-1' })] });
    await expect(issued.service.deleteMyEvidenceFromSkill(TECH, 'svc-1', 'd1')).rejects.toThrow('Verification document not found');
    for (const h of [approved, otherSkill, foreign, issued]) expect(h.documents.remove).not.toHaveBeenCalled();
  });
});

describe('TechnicianSkillVerificationsService: a skill the technician switched off is not reviewed', () => {
  function reviewHarness(isActive: boolean) {
    const verification = { id: 'rq1', technicianSkillId: 's1', status: VerificationStatus.PENDING, technicianSkill: { id: 's1', isActive, technician: { userId: TECH } } };
    const manager = { getRepository: () => ({ findOne: vi.fn().mockResolvedValue(verification), update: vi.fn().mockResolvedValue({ affected: 1 }) }) };
    const verificationRepo = { findOne: vi.fn().mockResolvedValue(verification), manager: { transaction: (fn: (m: unknown) => unknown) => fn(manager) } };
    const service = new TechnicianSkillVerificationsService(verificationRepo as any, {} as any, {} as any, {} as any, { logWithManagerStrict: vi.fn() } as any, { validateObjectPath: vi.fn(), objectExists: vi.fn().mockResolvedValue(true) } as any);
    return service;
  }

  it('answers 409 to reject and approve of a switched-off skill', async () => {
    const off = reviewHarness(false);
    await expect(off.reject('rq1', 'sm-1', { rejectionReason: 'Chưa đủ căn cứ' })).rejects.toBeInstanceOf(ConflictException);
    await expect(off.approve('rq1', 'sm-1', { storageObjectPath: `kyc/${TECH}/c.pdf`, fileName: 'c.pdf', fileSize: 1, mimeType: 'application/pdf' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the request out of the managers queue', async () => {
    const qb: any = {};
    for (const method of ['leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take']) qb[method] = vi.fn(() => qb);
    qb.getManyAndCount = vi.fn().mockResolvedValue([[], 0]);
    const service = new TechnicianSkillVerificationsService({ createQueryBuilder: () => qb } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await service.findAll({ page: 1, limit: 10, skip: 0 } as any);
    expect(qb.andWhere).toHaveBeenCalledWith('skill.isActive = true');
  });
});

describe('TechnicianSkillVerificationsService review notices and history', () => {
  const at = (n: number) => new Date(2026, 10, n);
  const request = (id: string, status: VerificationStatus, day: number, rejectionReason: string | null = null) => ({ id, technicianSkillId: 's1', status, submittedAt: at(day), rejectionReason });

  it('numbers the attempt of a request and names the reason of the last refusal before it', async () => {
    const { service } = build({ history: [request('a', VerificationStatus.REJECTED, 1, 'Ảnh mờ'), request('b', VerificationStatus.REJECTED, 2, 'Thiếu dấu'), request('c', VerificationStatus.PENDING, 3)] });
    const run = (id: string, day: number) => (service as any).withHistory([{ id, technicianSkillId: 's1', submittedAt: at(day) }]);
    expect((await run('a', 1))[0]).toMatchObject({ attemptNumber: 1, previousRejectionReason: null });
    expect((await run('c', 3))[0]).toMatchObject({ attemptNumber: 3, previousRejectionReason: 'Thiếu dấu' });
  });

  it('tells the technician how the review ended, with the reason, and never throws', () => {
    const { service, notifications } = build();
    const verification = { rejectionReason: 'Ảnh mờ', technicianSkill: { id: 's1', technician: { userId: TECH }, service: { name: 'Sửa điều hòa' } } };
    (service as any).notifyTechnician(verification, 'rejected');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: TECH, type: 'SKILL_VERIFICATION_REJECTED', message: expect.stringContaining('Ảnh mờ') }));
    (service as any).notifyTechnician(verification, 'approved');
    expect(notifications.createNotification).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'SKILL_VERIFICATION_APPROVED' }));
    notifications.createNotification.mockRejectedValue(new Error('db down'));
    expect(() => (service as any).notifyTechnician(verification, 'approved')).not.toThrow();
  });
});

describe('TechnicianSkillVerificationsService: a new paper never reopens a refused skill', () => {
  function attachHarness(skills: object[], refused: object | null) {
    const documents = { create: vi.fn((v) => v), save: vi.fn(), find: vi.fn().mockResolvedValue([]) };
    const verificationRepo = {
      findOne: vi.fn(async ({ where }: { where: { status: VerificationStatus } }) => (where.status === VerificationStatus.REJECTED ? refused : null)),
      create: vi.fn((v) => v),
      save: vi.fn(async (v) => ({ id: 'rq-new', ...v })),
      manager: { getRepository: () => ({ update: vi.fn(), create: vi.fn((v) => v), save: vi.fn() }) },
    };
    const notifications = { createManyNotifications: vi.fn(), createNotification: vi.fn() };
    const service = new TechnicianSkillVerificationsService(
      verificationRepo as any,
      { find: vi.fn().mockResolvedValue(skills), findOne: vi.fn() } as any,
      { findOne: vi.fn().mockResolvedValue({ id: 'p1' }) } as any,
      documents as any,
      { log: vi.fn() } as any,
      { validateObjectPath: vi.fn(), objectExists: vi.fn().mockResolvedValue(true) } as any,
      notifications as any,
      {} as any,
    );
    return { service, documents, verificationRepo, notifications };
  }
  const dto = { categoryIds: ['c1'], storageObjectPath: `kyc/${TECH}/a.jpg`, fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg' };
  const rejectedSkill = (id: string) => ({ id, serviceId: `svc-${id}`, isActive: true, verificationStatus: VerificationStatus.REJECTED });

  it('puts the paper on the latest refused request of each refused skill, opens nothing and tells nobody', async () => {
    const { service, documents, verificationRepo, notifications } = attachHarness([rejectedSkill('s1')], { id: 'rq-refused' });
    await service.attachEvidenceToCategories(TECH, dto as any);
    expect(documents.save).toHaveBeenCalledWith([expect.objectContaining({ skillVerificationId: 'rq-refused' })]);
    expect(verificationRepo.save).not.toHaveBeenCalled();
    expect(notifications.createManyNotifications).not.toHaveBeenCalled();
  });

  it('still opens a request for a skill that was never refused', async () => {
    const { service, verificationRepo } = attachHarness([{ id: 's2', serviceId: 'svc-s2', isActive: true, verificationStatus: VerificationStatus.PENDING }], null);
    await service.attachEvidenceToCategories(TECH, dto as any);
    expect(verificationRepo.save).toHaveBeenCalledTimes(1);
  });
});

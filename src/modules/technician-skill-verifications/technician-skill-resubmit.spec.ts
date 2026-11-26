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

describe('TechnicianSkillVerificationsService.updateMyEvidence replaces the photo', () => {
  const row = (id: string, skillId: string) => ({
    id, storageObjectPath: `kyc/${TECH}/old.jpg`, fileName: 'old.jpg', fileSize: 10, mimeType: 'image/jpeg', issuedById: null,
    skillVerification: { id: `rq-${skillId}`, technicianSkillId: skillId, status: VerificationStatus.REJECTED, technicianSkill: { id: skillId, technicianId: 'p1', verificationStatus: VerificationStatus.REJECTED, service: { categoryId: 'c1' } } },
  });
  const photo = { storageObjectPath: `kyc/${TECH}/new.jpg`, fileName: 'new.jpg', fileSize: 20, mimeType: 'image/png' };
  const dto = { categoryIds: ['c1'], evidenceType: 'social_insurance' };

  function withSkills() {
    const h = build({ rows: [row('d1', 's1')] });
    (h.service as any).skillRepo.find.mockResolvedValue([{ id: 's1', verificationStatus: VerificationStatus.REJECTED, isActive: true, service: { name: 'x' } }]);
    vi.spyOn(h.service, 'listMyEvidence').mockResolvedValue([]);
    return h;
  }

  it('stores the new file on the rows and removes the old one once nothing points at it', async () => {
    const { service, documents, storage } = withSkills();
    await service.updateMyEvidence(TECH, 'd1', { ...dto, ...photo } as any);
    expect(storage.objectExists).toHaveBeenCalledWith(photo.storageObjectPath, TECH);
    expect(documents.update).toHaveBeenCalledWith(['d1'], expect.objectContaining(photo));
    expect(storage.remove).toHaveBeenCalledWith([`kyc/${TECH}/old.jpg`]);
  });

  it('keeps the old file while another row still points at it', async () => {
    const { service, storage } = build({ rows: [row('d1', 's1')], remaining: 1 }) as any;
    service.skillRepo.find.mockResolvedValue([{ id: 's1', verificationStatus: VerificationStatus.REJECTED, isActive: true }]);
    vi.spyOn(service, 'listMyEvidence').mockResolvedValue([]);
    await service.updateMyEvidence(TECH, 'd1', { ...dto, ...photo } as any);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('refuses a photo that was never uploaded, one from another folder, and a half-sent file', async () => {
    const ghost = withSkills();
    ghost.storage.objectExists.mockResolvedValue(false);
    await expect(ghost.service.updateMyEvidence(TECH, 'd1', { ...dto, ...photo } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(ghost.documents.update).not.toHaveBeenCalled();
    const foreign = withSkills();
    await expect(foreign.service.updateMyEvidence(TECH, 'd1', { ...dto, ...photo, storageObjectPath: 'kyc/other/new.jpg' } as any)).rejects.toThrow('KYC prefix');
    const half = withSkills();
    await expect(half.service.updateMyEvidence(TECH, 'd1', { ...dto, storageObjectPath: photo.storageObjectPath } as any)).rejects.toThrow('đủ');
    expect(half.documents.update).not.toHaveBeenCalled();
  });

  it('leaves the file alone when no new photo is sent', async () => {
    const { service, documents, storage } = withSkills();
    await service.updateMyEvidence(TECH, 'd1', dto as any);
    expect(documents.update.mock.calls[0][1]).not.toHaveProperty('storageObjectPath');
    expect(storage.objectExists).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
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

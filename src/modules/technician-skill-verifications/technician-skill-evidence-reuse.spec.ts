// src/modules/technician-skill-verifications/technician-skill-evidence-reuse.spec.ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { VerificationStatus } from '../../shared/enums';

const TECH = 'tech-user-1';
const pending = (id: string, name: string) => ({ id, serviceId: `svc-${id}`, isActive: true, verificationStatus: VerificationStatus.PENDING, service: { name } });
const upload = { storageObjectPath: `kyc/${TECH}/new.jpg`, fileName: 'new.jpg', fileSize: 10, mimeType: 'image/jpeg', evidenceType: 'national_skill_certificate', referenceNumber: ' ab-123 ' };
const storage = { validateObjectPath: vi.fn(), objectExists: vi.fn().mockResolvedValue(true) };

describe('the same paper is not stored twice on one skill', () => {
  function attachSingle(held: object[]) {
    const documents = { create: vi.fn((v) => v), save: vi.fn(), find: vi.fn().mockResolvedValue(held) };
    const service = new TechnicianSkillVerificationsService(
      { findOne: vi.fn().mockResolvedValue({ id: 'rq1' }), find: vi.fn(), create: vi.fn(), save: vi.fn() } as any,
      { findOne: vi.fn().mockResolvedValue(pending('s1', 'Sửa điều hòa')) } as any,
      { findOne: vi.fn().mockResolvedValue({ id: 'p1' }) } as any,
      documents as any,
      { log: vi.fn() } as any,
      storage as any,
    );
    vi.spyOn(service, 'findById').mockResolvedValue({ id: 'rq1' } as any);
    return { service, documents };
  }

  function attachCategory(skills: object[], heldByRequest: Record<string, object[]>) {
    const documents = {
      create: vi.fn((v) => v),
      save: vi.fn(),
      find: vi.fn(async ({ where }: { where: { skillVerificationId: string } }) => heldByRequest[where.skillVerificationId] ?? []),
    };
    let n = 0;
    const service = new TechnicianSkillVerificationsService(
      { findOne: vi.fn(async () => ({ id: `rq${++n}` })), find: vi.fn(), create: vi.fn(), save: vi.fn() } as any,
      { find: vi.fn().mockResolvedValue(skills) } as any,
      { findOne: vi.fn().mockResolvedValue({ id: 'p1' }) } as any,
      documents as any,
      { log: vi.fn() } as any,
      storage as any,
    );
    return { service, documents };
  }

  it('refuses a number already on the skill (same type, any case or spacing), and a file already on it', async () => {
    for (const held of [
      [{ storageObjectPath: 'kyc/other/old.jpg', evidenceType: 'national_skill_certificate', referenceNumber: 'AB-123' }],
      [{ storageObjectPath: upload.storageObjectPath, evidenceType: null, referenceNumber: null }],
    ]) {
      const h = attachSingle(held);
      await expect(h.service.attachEvidence(TECH, 'svc-s1', upload as any)).rejects.toThrow('Giấy tờ này đã có ở kỹ năng Sửa điều hòa');
      expect(h.documents.save).not.toHaveBeenCalled();
    }
  });

  it('still takes a paper of another number or type, and one with no number at all', async () => {
    const held = [
      { storageObjectPath: 'kyc/other/old.jpg', evidenceType: 'work_photos', referenceNumber: null },
      { storageObjectPath: 'kyc/other/old2.jpg', evidenceType: 'national_skill_certificate', referenceNumber: 'AB-123' },
    ];
    for (const body of [{ ...upload, referenceNumber: 'ZZ-9' }, { ...upload, evidenceType: 'vocational_diploma' }, { ...upload, evidenceType: 'work_photos', referenceNumber: undefined }]) {
      const h = attachSingle(held);
      await h.service.attachEvidence(TECH, 'svc-s1', body as any);
      expect(h.documents.save).toHaveBeenCalledTimes(1);
    }
  });

  it('by category skips the skills that hold it, and refuses only when every skill does', async () => {
    const some = attachCategory([pending('s1', 'Sửa điều hòa'), pending('s2', 'Sửa tủ lạnh')], { rq1: [{ evidenceType: 'national_skill_certificate', referenceNumber: 'ab-123', storageObjectPath: 'x' }] });
    await some.service.attachEvidenceToCategories(TECH, { ...upload, categoryIds: ['c1'] } as any);
    expect(some.documents.save).toHaveBeenCalledWith([expect.objectContaining({ skillVerificationId: 'rq2' })]);

    const file = { storageObjectPath: upload.storageObjectPath };
    const all = attachCategory([pending('s1', 'Sửa điều hòa'), pending('s2', 'Sửa tủ lạnh')], { rq1: [file], rq2: [file] });
    await expect(all.service.attachEvidenceToCategories(TECH, { ...upload, categoryIds: ['c1'] } as any)).rejects.toThrow('Sửa điều hòa, Sửa tủ lạnh');
  });
});

describe('TechnicianSkillVerificationsService.reuseMyEvidence', () => {
  const owned = (id: string, over: object = {}) => ({
    id, issuedById: null, storageObjectPath: `kyc/${TECH}/${id}.jpg`, fileName: `${id}.jpg`, fileSize: 10, mimeType: 'image/jpeg',
    evidenceType: 'social_insurance', evidenceGroup: 'experience', issuer: 'BHXH', referenceNumber: null, issuedAt: null, expiresAt: null, claimedYears: 5,
    skillVerification: { technicianSkill: { technicianId: 'p1' } }, ...over,
  });
  function harness(sources: object[], held: object[] = [], skill: object | null = pending('s1', 'Sửa điều hòa')) {
    const documents = {
      create: vi.fn((v) => v),
      save: vi.fn(),
      find: vi.fn(async (q: { where: { id?: unknown } }) => (q.where.id ? sources : held)),
    };
    const audit = { log: vi.fn() };
    const service = new TechnicianSkillVerificationsService(
      { findOne: vi.fn().mockResolvedValue({ id: 'rq1' }), find: vi.fn(), create: vi.fn(), save: vi.fn() } as any,
      { findOne: vi.fn().mockResolvedValue(skill) } as any,
      { findOne: vi.fn().mockResolvedValue({ id: 'p1' }) } as any,
      documents as any,
      audit as any,
      storage as any,
    );
    return { service, documents, audit };
  }
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

  it('copies the papers onto the skill request and traces it', async () => {
    const h = harness([owned(ids[0]), owned(ids[1], { evidenceType: 'vocational_diploma', referenceNumber: 'D-1' })]);
    await expect(h.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: ids })).resolves.toEqual({ attached: 2, skipped: 0 });
    expect(h.documents.save).toHaveBeenCalledWith([
      expect.objectContaining({ skillVerificationId: 'rq1', storageObjectPath: `kyc/${TECH}/${ids[0]}.jpg`, issuedById: null, claimedYears: 5 }),
      expect.objectContaining({ referenceNumber: 'D-1' }),
    ]);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SKILL_EVIDENCE_ATTACHED', after: expect.objectContaining({ reused: true }) }));
  });

  it('skips a paper the skill already holds, and two chosen papers that are the same file', async () => {
    const twice = harness([owned(ids[0]), owned(ids[1], { storageObjectPath: `kyc/${TECH}/${ids[0]}.jpg` })]);
    await expect(twice.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: ids })).resolves.toEqual({ attached: 1, skipped: 1 });
    const held = harness([owned(ids[0])], [{ storageObjectPath: `kyc/${TECH}/${ids[0]}.jpg` }]);
    await expect(held.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: [ids[0]] })).resolves.toEqual({ attached: 0, skipped: 1 });
    expect(held.documents.save).not.toHaveBeenCalled();
  });

  it('refuses a paper of another technician, a FixHome certificate, an expired paper and an unknown skill', async () => {
    const foreign = harness([owned(ids[0], { skillVerification: { technicianSkill: { technicianId: 'p2' } } })]);
    await expect(foreign.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: [ids[0]] })).rejects.toThrow('Verification document not found');
    const issued = harness([owned(ids[0], { issuedById: 'admin-1' })]);
    await expect(issued.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: [ids[0]] })).rejects.toThrow('Verification document not found');
    const expired = harness([owned(ids[0], { expiresAt: '2000-01-01' })]);
    await expect(expired.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: [ids[0]] })).rejects.toBeInstanceOf(BadRequestException);
    const noSkill = harness([owned(ids[0])], [], null);
    await expect(noSkill.service.reuseMyEvidence(TECH, 'svc-1', { documentIds: [ids[0]] })).rejects.toThrow('Skill not found');
    expect(foreign.documents.save).not.toHaveBeenCalled();
  });
});

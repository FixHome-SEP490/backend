// src/modules/technicians/skill-verification-request.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { ensurePendingSkillVerification } from './skill-verification-request';
import { VerificationStatus } from '../../shared/enums';

const skill = (extra: object = {}) => ({ id: 's1', isActive: true, verificationStatus: VerificationStatus.PENDING, ...extra });
const repo = (over: Record<string, unknown> = {}) => ({
  findOne: vi.fn().mockResolvedValue(null),
  create: vi.fn((v) => v),
  save: vi.fn(async (v) => ({ id: 'req-1', ...v })),
  ...over,
});

describe('ensurePendingSkillVerification', () => {
  it('needs no request for a confirmed or inactive skill', async () => {
    const r = repo();
    expect(await ensurePendingSkillVerification(r as never, skill({ verificationStatus: VerificationStatus.VERIFIED }))).toBeNull();
    expect(await ensurePendingSkillVerification(r as never, skill({ isActive: false }))).toBeNull();
    expect(r.findOne).not.toHaveBeenCalled();
  });

  it('returns the pending request that already exists without saving another', async () => {
    const r = repo({ findOne: vi.fn().mockResolvedValue({ id: 'old' }) });
    expect(await ensurePendingSkillVerification(r as never, skill())).toEqual({ id: 'old' });
    expect(r.save).not.toHaveBeenCalled();
  });

  it('opens a pending request when there is none', async () => {
    const r = repo();
    expect(await ensurePendingSkillVerification(r as never, skill())).toMatchObject({ id: 'req-1', technicianSkillId: 's1', status: VerificationStatus.PENDING });
  });

  it('treats a unique violation from a racing caller as "already open" and reads it back', async () => {
    const findOne = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'raced' });
    const save = vi.fn().mockRejectedValue(new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: '23505' })));
    expect(await ensurePendingSkillVerification(repo({ findOne, save }) as never, skill())).toEqual({ id: 'raced' });
  });

  it('does not swallow any other database error', async () => {
    const save = vi.fn().mockRejectedValue(new QueryFailedError('INSERT', [], Object.assign(new Error('boom'), { code: '42P01' })));
    await expect(ensurePendingSkillVerification(repo({ save }) as never, skill())).rejects.toThrow('boom');
  });
});

describe('ensurePendingSkillVerification carries a rejected skill\'s papers to the new request', () => {
  const paper = (over: object = {}) => ({
    id: 'd1', issuedById: null, documentType: 'certificate', storageObjectPath: 'kyc/u1/a.jpg',
    fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg', evidenceType: 'social_insurance', issuer: 'BHXH', ...over,
  });
  const build = (opts: { pending?: object | null; rejected?: object | null } = {}) => {
    const documents = { create: vi.fn((v) => v), save: vi.fn() };
    const verifications = {
      findOne: vi.fn(async ({ where }: { where: { status: VerificationStatus } }) =>
        where.status === VerificationStatus.PENDING ? (opts.pending ?? null) : (opts.rejected ?? null)),
      create: vi.fn((v) => v),
      save: vi.fn(async (v) => ({ id: 'rq-new', ...v })),
      manager: { getRepository: () => documents },
    };
    return { verifications, documents };
  };

  it('copies the technician papers, not the certificate FixHome issued', async () => {
    const { verifications, documents } = build({ rejected: { documents: [paper(), paper({ id: 'd2', issuedById: 'admin-1' })] } });
    await ensurePendingSkillVerification(verifications as never, skill({ verificationStatus: VerificationStatus.REJECTED }));
    expect(documents.save).toHaveBeenCalledWith([expect.objectContaining({ skillVerificationId: 'rq-new', storageObjectPath: 'kyc/u1/a.jpg', issuer: 'BHXH' })]);
    expect(documents.save.mock.calls[0][0]).toHaveLength(1);
  });

  it('copies nothing again once a pending request is open', async () => {
    const { verifications, documents } = build({ pending: { id: 'rq-open' }, rejected: { documents: [paper()] } });
    await expect(ensurePendingSkillVerification(verifications as never, skill({ verificationStatus: VerificationStatus.REJECTED }))).resolves.toEqual({ id: 'rq-open' });
    expect(documents.save).not.toHaveBeenCalled();
  });

  it('copies nothing for a skill that was never rejected', async () => {
    const { verifications, documents } = build({ rejected: { documents: [paper()] } });
    await ensurePendingSkillVerification(verifications as never, skill());
    expect(documents.save).not.toHaveBeenCalled();
  });
});

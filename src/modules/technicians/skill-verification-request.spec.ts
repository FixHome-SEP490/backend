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

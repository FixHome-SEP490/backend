// src/modules/technicians/skill-verification-request.ts
import { QueryFailedError, Repository } from 'typeorm';
import { VerificationStatus } from '../../shared/enums';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { TechnicianSkillVerification } from './entities/technician-skill-verification.entity';

const UNIQUE_VIOLATION = '23505';

/**
 * Makes sure an active, unconfirmed skill has a pending verification request to attach evidence to. A skill that is
 * already confirmed or inactive gets none. The partial unique index `idx_one_open_skill_verification` is the real guard
 * against duplicates: when two callers race, the loser's insert fails with a unique violation and is treated as "already
 * open" instead of an error. Returns the open (pending) request, or null when the skill needs none.
 */
export async function ensurePendingSkillVerification(
  verifications: Repository<TechnicianSkillVerification>,
  skill: Pick<TechnicianSkill, 'id' | 'isActive' | 'verificationStatus'>,
): Promise<TechnicianSkillVerification | null> {
  if (!skill.isActive || skill.verificationStatus === VerificationStatus.VERIFIED) return null;

  const findPending = () =>
    verifications.findOne({ where: { technicianSkillId: skill.id, status: VerificationStatus.PENDING } });
  const existing = await findPending();
  if (existing) return existing;

  try {
    return await verifications.save(
      verifications.create({ technicianSkillId: skill.id, status: VerificationStatus.PENDING }),
    );
  } catch (error) {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION) {
      return findPending();
    }
    throw error;
  }
}

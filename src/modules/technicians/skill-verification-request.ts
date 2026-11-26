// src/modules/technicians/skill-verification-request.ts
import { QueryFailedError, Repository } from 'typeorm';
import { VerificationStatus } from '../../shared/enums';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { TechnicianSkillVerification } from './entities/technician-skill-verification.entity';

const UNIQUE_VIOLATION = '23505';

/** A skill switched back on after a rejection keeps the technician's papers: copies them from the latest rejected request. */
async function carryOverPapers(verifications: Repository<TechnicianSkillVerification>, skillId: string, requestId: string) {
  const rejected = await verifications.findOne({
    where: { technicianSkillId: skillId, status: VerificationStatus.REJECTED },
    order: { submittedAt: 'DESC' },
    relations: ['documents'],
  });
  const papers = (rejected?.documents ?? []).filter((d) => !d.issuedById);
  if (papers.length === 0) return;
  const documents = verifications.manager.getRepository(VerificationDocument);
  await documents.save(
    papers.map((p) =>
      documents.create({
        skillVerificationId: requestId,
        documentType: p.documentType,
        storageObjectPath: p.storageObjectPath,
        fileName: p.fileName,
        fileSize: p.fileSize,
        mimeType: p.mimeType,
        issuedById: null,
        evidenceType: p.evidenceType,
        evidenceGroup: p.evidenceGroup,
        issuer: p.issuer,
        referenceNumber: p.referenceNumber,
        issuedAt: p.issuedAt,
        expiresAt: p.expiresAt,
        claimedYears: p.claimedYears,
        reviewStatus: p.reviewStatus,
      }),
    ),
  );
}

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
    const request = await verifications.save(
      verifications.create({ technicianSkillId: skill.id, status: VerificationStatus.PENDING }),
    );
    if (skill.verificationStatus === VerificationStatus.REJECTED) await carryOverPapers(verifications, skill.id, request.id);
    return request;
  } catch (error) {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION) {
      return findPending();
    }
    throw error;
  }
}

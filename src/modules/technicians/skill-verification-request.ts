// src/modules/technicians/skill-verification-request.ts
import { In, QueryFailedError, Repository } from 'typeorm';
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

/** A rejected skill with an open request is back in review: the app and the reviewer must see the same state. */
async function backToReview(verifications: Repository<TechnicianSkillVerification>, skill: Pick<TechnicianSkill, 'id' | 'verificationStatus'>) {
  if (skill.verificationStatus !== VerificationStatus.REJECTED) return;
  await verifications.manager.getRepository(TechnicianSkill).update(skill.id, { verificationStatus: VerificationStatus.PENDING });
  skill.verificationStatus = VerificationStatus.PENDING;
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
  if (existing) {
    await backToReview(verifications, skill);
    return existing;
  }

  try {
    const request = await verifications.save(
      verifications.create({ technicianSkillId: skill.id, status: VerificationStatus.PENDING }),
    );
    if (skill.verificationStatus === VerificationStatus.REJECTED) await carryOverPapers(verifications, skill.id, request.id);
    await backToReview(verifications, skill);
    return request;
  } catch (error) {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION) {
      return findPending();
    }
    throw error;
  }
}

/**
 * ensurePendingSkillVerification for many skills in a constant number of queries (one read, one insert, one update)
 * instead of several per skill. Returns the open request by skill id; skills that need none are absent.
 */
export async function ensurePendingSkillVerifications(
  verifications: Repository<TechnicianSkillVerification>,
  skills: Pick<TechnicianSkill, 'id' | 'isActive' | 'verificationStatus'>[],
): Promise<Map<string, TechnicianSkillVerification>> {
  const result = new Map<string, TechnicianSkillVerification>();
  const eligible = skills.filter((s) => s.isActive && s.verificationStatus !== VerificationStatus.VERIFIED);
  if (eligible.length === 0) return result;

  const open = await verifications.find({
    where: { technicianSkillId: In(eligible.map((s) => s.id)), status: VerificationStatus.PENDING },
  });
  for (const request of open) result.set(request.technicianSkillId, request);

  const missing = eligible.filter((s) => !result.has(s.id));
  if (missing.length > 0) {
    try {
      const created = await verifications.save(
        missing.map((s) => verifications.create({ technicianSkillId: s.id, status: VerificationStatus.PENDING })),
      );
      for (const request of created) result.set(request.technicianSkillId, request);
      for (const s of missing) {
        if (s.verificationStatus === VerificationStatus.REJECTED) await carryOverPapers(verifications, s.id, result.get(s.id)!.id);
      }
    } catch (error) {
      if (!(error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION)) throw error;
      // A concurrent caller opened one of them and the whole insert rolled back: settle each skill on its own.
      for (const s of missing) {
        const request = await ensurePendingSkillVerification(verifications, s);
        if (request) result.set(s.id, request);
      }
    }
  }

  const rejected = eligible.filter((s) => s.verificationStatus === VerificationStatus.REJECTED);
  if (rejected.length > 0) {
    await verifications.manager.getRepository(TechnicianSkill).update(rejected.map((s) => s.id), { verificationStatus: VerificationStatus.PENDING });
    for (const s of rejected) s.verificationStatus = VerificationStatus.PENDING;
  }
  return result;
}

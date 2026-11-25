import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { ensurePendingSkillVerification } from '../technicians/skill-verification-request';
import {
  DocumentType,
  SKILL_EVIDENCE_GROUP_BY_TYPE,
  SkillEvidenceReviewStatus,
  Role,
  VerificationStatus,
} from '../../shared/enums';
import { PaginationMeta } from '../../shared/dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { KycStorageService, KycSignedAccess, KycSignedUpload } from '../technician-verifications/kyc-storage.service';
import {
  AttachSkillEvidenceDto,
  QuerySkillVerificationsDto,
  RejectSkillVerificationDto,
  SkillVerificationResponseDto,
  SubmitCategoryEvidenceDto,
  SubmitSkillEvidenceDto,
} from './dto';
import {
  toSkillVerificationResponse,
  toSkillVerificationResponseList,
} from './technician-skill-verifications.mapper';

export const SKILL_EVIDENCE_NOT_UPLOADED =
  'Không tìm thấy tệp chứng chỉ đã tải lên. Vui lòng tải lại tệp rồi gửi.';

const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * Metadata columns for a technician's evidence. The trust group comes from the type, never from the client.
 * Details without a type are refused so a row never carries half a description; no type and no details
 * (a client that sends only the file) stores nothing extra.
 */
export function skillEvidenceMetadata(dto: SubmitSkillEvidenceDto) {
  const { evidenceType, issuer, referenceNumber, issuedAt, expiresAt, claimedYears } = dto;
  if (!evidenceType) {
    if (issuer || referenceNumber || issuedAt || expiresAt || claimedYears !== undefined) {
      throw new BadRequestException('evidenceType is required when evidence details are given');
    }
    return {};
  }
  if ((issuedAt && !isCalendarDate(issuedAt)) || (expiresAt && !isCalendarDate(expiresAt))) {
    throw new BadRequestException('issuedAt and expiresAt must be real calendar dates');
  }
  if (issuedAt && expiresAt && expiresAt < issuedAt) {
    throw new BadRequestException('expiresAt must not be before issuedAt');
  }
  return {
    evidenceType,
    evidenceGroup: SKILL_EVIDENCE_GROUP_BY_TYPE[evidenceType],
    issuer: issuer || null,
    referenceNumber: referenceNumber || null,
    issuedAt: issuedAt ?? null,
    expiresAt: expiresAt ?? null,
    claimedYears: claimedYears ?? null,
    reviewStatus: SkillEvidenceReviewStatus.PENDING,
  };
}

const VERIFICATION_RELATIONS = [
  'technicianSkill',
  'technicianSkill.service',
  'technicianSkill.technician',
  'technicianSkill.technician.user',
  'documents',
  'reviewedBy',
];

@Injectable()
export class TechnicianSkillVerificationsService {
  constructor(
    @InjectRepository(TechnicianSkillVerification)
    private readonly verificationRepo: Repository<TechnicianSkillVerification>,
    @InjectRepository(TechnicianSkill)
    private readonly skillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(VerificationDocument)
    private readonly documentRepo: Repository<VerificationDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly storageService: KycStorageService,
  ) {}

  // ---- Technician-facing ----

  async createEvidenceUploadUrl(
    technicianUserId: string,
    mimeType: string,
  ): Promise<KycSignedUpload> {
    return this.storageService.createSignedUploadUrl(technicianUserId, mimeType);
  }

  /**
   * One paper for every skill the technician has in the chosen categories (PO 24/11/2026): one document row per skill,
   * all pointing at the same stored file, so the reviewer still sees the evidence per skill. Confirmed and inactive
   * skills are skipped. The requests are opened before the insert, outside any transaction, because a unique
   * violation inside one would abort it; the insert itself is a single atomic save.
   */
  async attachEvidenceToCategories(
    technicianUserId: string,
    dto: SubmitCategoryEvidenceDto,
  ): Promise<{ attachedSkills: number; serviceIds: string[] }> {
    const metadata = skillEvidenceMetadata(dto);
    this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');

    const skills = await this.skillRepo.find({
      where: { technicianId: profile.id, isActive: true, service: { categoryId: In(dto.categoryIds) } },
    });
    const waiting = skills.filter((skill) => skill.verificationStatus !== VerificationStatus.VERIFIED);
    if (waiting.length === 0) {
      throw new NotFoundException('Bạn chưa có kỹ năng nào chờ xác minh thuộc các nhóm đã chọn.');
    }
    await this.assertUploaded(dto.storageObjectPath, technicianUserId);

    const targets: { serviceId: string; request: TechnicianSkillVerification }[] = [];
    for (const skill of waiting) {
      const request = await ensurePendingSkillVerification(this.verificationRepo, skill);
      if (request) targets.push({ serviceId: skill.serviceId, request });
    }
    if (targets.length === 0) {
      throw new ConflictException('Các kỹ năng này chưa có yêu cầu xác minh để đính giấy tờ.');
    }

    await this.documentRepo.save(
      targets.map(({ request }) =>
        this.documentRepo.create({
          skillVerificationId: request.id,
          documentType: DocumentType.CERTIFICATE,
          storageObjectPath: dto.storageObjectPath,
          fileName: dto.fileName,
          fileSize: dto.fileSize,
          mimeType: dto.mimeType,
          issuedById: null,
          ...metadata,
        }),
      ),
    );
    return { attachedSkills: targets.length, serviceIds: targets.map((target) => target.serviceId) };
  }

  async attachEvidence(
    technicianUserId: string,
    serviceId: string,
    dto: SubmitSkillEvidenceDto,
  ): Promise<SkillVerificationResponseDto> {
    const metadata = skillEvidenceMetadata(dto);
    this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');

    const skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
    });
    if (!skill) throw new NotFoundException('Skill not found');

    const verification = await this.verificationRepo.findOne({
      where: { technicianSkillId: skill.id, status: VerificationStatus.PENDING },
      order: { submittedAt: 'DESC' },
    });
    if (!verification) {
      throw new ConflictException(
        'This skill has no pending verification request to attach evidence to',
      );
    }
    // The path proves the owner, the bucket proves the upload: a path that was
    // never uploaded through the signed upload URL is refused before anything
    // is saved (storage unreachable is a 503 from objectExists).
    await this.assertUploaded(dto.storageObjectPath, technicianUserId);

    await this.documentRepo.save(
      this.documentRepo.create({
        skillVerificationId: verification.id,
        documentType: DocumentType.CERTIFICATE,
        storageObjectPath: dto.storageObjectPath,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
        issuedById: null,
        ...metadata,
      }),
    );

    return this.findById(verification.id);
  }

  async getMySkillVerification(
    technicianUserId: string,
    serviceId: string,
  ): Promise<SkillVerificationResponseDto | null> {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) return null;

    const skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
    });
    if (!skill) return null;

    // The technician sees the outcome, not the reviewing admin's account
    // (email, status), so the reviewer relation is not loaded here.
    const verification = await this.verificationRepo.findOne({
      where: { technicianSkillId: skill.id },
      order: { submittedAt: 'DESC' },
      relations: VERIFICATION_RELATIONS.filter((relation) => relation !== 'reviewedBy'),
    });
    return verification ? toSkillVerificationResponse(verification) : null;
  }

  // ---- Admin-facing ----

  async findAll(
    query: QuerySkillVerificationsDto,
  ): Promise<{ data: SkillVerificationResponseDto[]; meta: PaginationMeta }> {
    const qb = this.verificationRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.technicianSkill', 'skill')
      .leftJoinAndSelect('skill.service', 'service')
      .leftJoinAndSelect('skill.technician', 'profile')
      .leftJoinAndSelect('profile.user', 'user')
      .leftJoinAndSelect('v.documents', 'documents')
      .leftJoinAndSelect('v.reviewedBy', 'reviewedBy');

    if (query.status) {
      qb.andWhere('v.status = :status', { status: query.status });
    }

    qb.orderBy('v.submittedAt', 'DESC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();

    const meta: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };

    return { data: toSkillVerificationResponseList(data), meta };
  }

  async findById(id: string): Promise<SkillVerificationResponseDto> {
    const verification = await this.verificationRepo.findOne({
      where: { id },
      relations: VERIFICATION_RELATIONS,
    });
    if (!verification) throw new NotFoundException('Skill verification request not found');
    return toSkillVerificationResponse(verification);
  }

  async approve(
    id: string,
    reviewerId: string,
    dto: AttachSkillEvidenceDto,
  ): Promise<SkillVerificationResponseDto> {
    // The issued certificate must be in the bucket too. Checked before the
    // transaction so no database connection waits on the storage call.
    const target = await this.verificationRepo.findOne({
      where: { id },
      relations: ['technicianSkill', 'technicianSkill.technician'],
    });
    if (!target) throw new NotFoundException('Skill verification request not found');
    await this.assertUploaded(
      dto.storageObjectPath,
      target.technicianSkill.technician.userId,
    );

    return this.verificationRepo.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(TechnicianSkillVerification);
      const verification = await verifications.findOne({
        where: { id },
        relations: ['technicianSkill', 'technicianSkill.technician', 'technicianSkill.technician.user'],
      });
      if (!verification) throw new NotFoundException('Skill verification request not found');

      const technicianUserId = verification.technicianSkill.technician.userId;
      this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

      const result = await verifications.update(
        { id, status: VerificationStatus.PENDING },
        { status: VerificationStatus.VERIFIED, reviewedById: reviewerId, reviewedAt: new Date() },
      );
      if (result.affected !== 1) {
        throw new ConflictException('Verification request is already processed');
      }

      await manager.getRepository(VerificationDocument).save(
        manager.getRepository(VerificationDocument).create({
          skillVerificationId: id,
          documentType: DocumentType.CERTIFICATE,
          storageObjectPath: dto.storageObjectPath,
          fileName: dto.fileName,
          fileSize: dto.fileSize,
          mimeType: dto.mimeType,
          issuedById: reviewerId,
        }),
      );

      const skillResult = await manager
        .getRepository(TechnicianSkill)
        .update(verification.technicianSkillId, {
          verificationStatus: VerificationStatus.VERIFIED,
        });
      if (skillResult.affected !== 1) {
        throw new NotFoundException('Technician skill not found');
      }

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.ADMIN,
        action: 'SKILL_VERIFICATION_APPROVED',
        resourceType: 'technician_skill_verification',
        resourceId: id,
        before: { status: verification.status },
        after: { status: VerificationStatus.VERIFIED, reviewedById: reviewerId },
      });

      const updated = await verifications.findOne({ where: { id }, relations: VERIFICATION_RELATIONS });
      if (!updated) throw new NotFoundException('Skill verification request not found');
      return toSkillVerificationResponse(updated);
    });
  }

  async reject(
    id: string,
    reviewerId: string,
    dto: RejectSkillVerificationDto,
  ): Promise<SkillVerificationResponseDto> {
    return this.verificationRepo.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(TechnicianSkillVerification);
      const verification = await verifications.findOne({ where: { id } });
      if (!verification) throw new NotFoundException('Skill verification request not found');

      const result = await verifications.update(
        { id, status: VerificationStatus.PENDING },
        {
          status: VerificationStatus.REJECTED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: dto.rejectionReason.trim(),
        },
      );
      if (result.affected !== 1) {
        throw new ConflictException('Verification request is already processed');
      }

      const skillResult = await manager
        .getRepository(TechnicianSkill)
        .update(verification.technicianSkillId, {
          verificationStatus: VerificationStatus.REJECTED,
        });
      if (skillResult.affected !== 1) {
        throw new NotFoundException('Technician skill not found');
      }

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.ADMIN,
        action: 'SKILL_VERIFICATION_REJECTED',
        resourceType: 'technician_skill_verification',
        resourceId: id,
        before: { status: verification.status },
        after: {
          status: VerificationStatus.REJECTED,
          reviewedById: reviewerId,
          rejectionReason: dto.rejectionReason.trim(),
        },
      });

      const updated = await verifications.findOne({ where: { id }, relations: VERIFICATION_RELATIONS });
      if (!updated) throw new NotFoundException('Skill verification request not found');
      return toSkillVerificationResponse(updated);
    });
  }

  private async assertUploaded(
    storageObjectPath: string,
    technicianUserId: string,
  ): Promise<void> {
    this.storageService.validateObjectPath(storageObjectPath, technicianUserId);
    const exists = await this.storageService.objectExists(
      storageObjectPath,
      technicianUserId,
    );
    if (!exists) throw new BadRequestException(SKILL_EVIDENCE_NOT_UPLOADED);
  }

  async createCertificateUploadUrl(
    verificationId: string,
    mimeType: string,
  ): Promise<KycSignedUpload> {
    const verification = await this.verificationRepo.findOne({
      where: { id: verificationId },
      relations: ['technicianSkill', 'technicianSkill.technician'],
    });
    if (!verification) throw new NotFoundException('Skill verification request not found');

    return this.storageService.createSignedUploadUrl(
      verification.technicianSkill.technician.userId,
      mimeType,
    );
  }

  async getSignedDocumentAccess(
    documentId: string,
    actor: { id: string; role: Role },
  ): Promise<KycSignedAccess> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
      relations: ['skillVerification', 'skillVerification.technicianSkill', 'skillVerification.technicianSkill.technician'],
    });
    if (!document || !document.skillVerification) {
      throw new NotFoundException('Verification document not found');
    }

    const technicianUserId = document.skillVerification.technicianSkill.technician.userId;
    const isAdmin = actor.role === Role.ADMIN;
    const isOwner = actor.role === Role.TECHNICIAN && technicianUserId === actor.id;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException('You do not have permission to access this document');
    }
    if (!document.storageObjectPath) {
      throw new NotFoundException('This document has no private storage reference');
    }

    return this.storageService.createSignedAccess(document.storageObjectPath, technicianUserId);
  }
}

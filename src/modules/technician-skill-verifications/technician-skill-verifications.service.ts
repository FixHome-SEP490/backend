import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { DocumentType, Role, VerificationStatus } from '../../shared/enums';
import { PaginationMeta } from '../../shared/dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { KycStorageService, KycSignedAccess, KycSignedUpload } from '../technician-verifications/kyc-storage.service';
import {
  AttachSkillEvidenceDto,
  QuerySkillVerificationsDto,
  RejectSkillVerificationDto,
  SkillVerificationResponseDto,
} from './dto';
import {
  toSkillVerificationResponse,
  toSkillVerificationResponseList,
} from './technician-skill-verifications.mapper';

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

  async attachEvidence(
    technicianUserId: string,
    serviceId: string,
    dto: AttachSkillEvidenceDto,
  ): Promise<SkillVerificationResponseDto> {
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

    await this.documentRepo.save(
      this.documentRepo.create({
        skillVerificationId: verification.id,
        documentType: DocumentType.CERTIFICATE,
        storageObjectPath: dto.storageObjectPath,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
        issuedById: null,
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

    const verification = await this.verificationRepo.findOne({
      where: { technicianSkillId: skill.id },
      order: { submittedAt: 'DESC' },
      relations: VERIFICATION_RELATIONS,
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

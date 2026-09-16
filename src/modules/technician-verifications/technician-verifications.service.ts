// src/modules/technician-verifications/technician-verifications.service.ts
import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianVerification } from './entities/technician-verification.entity';
import { VerificationDocument } from './entities/verification-document.entity';
import {
  VerificationStatus,
  DocumentType,
  AccountStatus,
  Role,
} from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { PaginationMeta } from '../../shared/dto';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  KycStorageService,
  KycSignedAccess,
  KycSignedUpload,
} from './kyc-storage.service';
import {
  SubmitVerificationDto,
  RejectVerificationDto,
  QueryVerificationsDto,
  RequestKycUploadUrlDto,
  TechnicianVerificationResponseDto,
} from './dto';
import {
  toTechnicianVerificationResponse,
  toTechnicianVerificationResponseList,
} from './technician-verifications.mapper';

@Injectable()
export class TechnicianVerificationsService {
  constructor(
    @InjectRepository(TechnicianVerification)
    private readonly verificationRepository: Repository<TechnicianVerification>,
    @InjectRepository(VerificationDocument)
    private readonly documentRepository: Repository<VerificationDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly storageService: KycStorageService,
  ) {}

  async submitVerification(
    technicianId: string,
    dto: SubmitVerificationDto,
  ): Promise<TechnicianVerificationResponseDto> {
    this.validateSubmissionDocuments(dto);

    const extensions: Record<string, string[]> = {
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/webp': ['webp'],
      'application/pdf': ['pdf'],
    };
    for (const doc of dto.documents) {
      this.storageService.validateObjectPath(
        doc.storageObjectPath,
        technicianId,
      );
      if (
        !extensions[doc.mimeType]?.includes(
          doc.fileName.split('.').pop()?.toLowerCase(),
        )
      )
        throw new BadRequestException(
          'Document extension does not match MIME type',
        );
    }
    const verification = await this.verificationRepository.manager.transaction(async (manager) => {
      const technician = await manager
        .getRepository(User)
        .findOne({
          where: { id: technicianId },
          lock: { mode: 'pessimistic_write' },
        });
      if (
        !technician ||
        technician.role !== Role.TECHNICIAN ||
        technician.status !== AccountStatus.ACTIVE ||
        !technician.isActive
      )
        throw new ForbiddenException('Active technician account required');
      const verifications = manager.getRepository(TechnicianVerification);
      const documentRepository = manager.getRepository(VerificationDocument);
      // Check if already pending
      const pending = await verifications.findOne({
        where: { technicianId, status: VerificationStatus.PENDING },
      });
      if (pending) {
        throw new ConflictException(
          'You already have a pending verification request under review.',
        );
      }

      // Check if already verified
      const verified = await verifications.findOne({
        where: { technicianId, status: VerificationStatus.VERIFIED },
      });
      if (verified) {
        throw new ConflictException('Your technician account is already verified.');
      }

      const verification = verifications.create({
        technicianId,
        status: VerificationStatus.PENDING,
        submittedAt: new Date(),
      });

      const savedVerification = await verifications.save(verification);

      const documents = dto.documents.map((doc) =>
        documentRepository.create({
          verificationId: savedVerification.id,
          documentType: doc.documentType,
          storageObjectPath: doc.storageObjectPath,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          mimeType: doc.mimeType,
        }),
      );

      savedVerification.documents = await documentRepository.save(documents);
      return savedVerification;
    });

    return toTechnicianVerificationResponse(verification);
  }

  async createDocumentUploadUrl(
    technicianId: string,
    dto: RequestKycUploadUrlDto,
  ): Promise<KycSignedUpload> {
    const technician = await this.verificationRepository.manager
      .getRepository(User)
      .findOne({ where: { id: technicianId } });
    if (
      !technician ||
      technician.role !== Role.TECHNICIAN ||
      technician.status !== AccountStatus.ACTIVE ||
      !technician.isActive
    )
      throw new ForbiddenException('Active technician account required');

    return this.storageService.createSignedUploadUrl(
      technicianId,
      dto.mimeType,
    );
  }

  async getMyVerification(
    technicianId: string,
  ): Promise<TechnicianVerificationResponseDto | null> {
    const verification = await this.verificationRepository.findOne({
      where: { technicianId },
      order: { submittedAt: 'DESC' },
      relations: ['documents'],
    });
    return verification ? toTechnicianVerificationResponse(verification) : null;
  }

  async findAll(
    query: QueryVerificationsDto,
  ): Promise<{
    data: TechnicianVerificationResponseDto[];
    meta: PaginationMeta;
  }> {
    const qb = this.verificationRepository
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.technician', 'technician')
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

    return { data: toTechnicianVerificationResponseList(data), meta };
  }

  async findById(id: string): Promise<TechnicianVerificationResponseDto> {
    const verification = await this.verificationRepository.findOne({
      where: { id },
      relations: ['technician', 'documents', 'reviewedBy'],
    });

    if (!verification) {
      throw new NotFoundException(
        `Verification request with ID ${id} not found`,
      );
    }

    return toTechnicianVerificationResponse(verification);
  }

  async approveVerification(
    id: string,
    reviewerId: string,
  ): Promise<TechnicianVerificationResponseDto> {
    const verification = await this.review(
      id,
      reviewerId,
      VerificationStatus.VERIFIED,
      null,
    );
    return toTechnicianVerificationResponse(verification);
  }

  async rejectVerification(
    id: string,
    reviewerId: string,
    dto: RejectVerificationDto,
  ): Promise<TechnicianVerificationResponseDto> {
    if (!dto.rejectionReason || dto.rejectionReason.trim().length < 5)
      throw new BadRequestException('Rejection reason is required');
    const verification = await this.review(
      id,
      reviewerId,
      VerificationStatus.REJECTED,
      dto.rejectionReason.trim(),
    );
    return toTechnicianVerificationResponse(verification);
  }

  async isVerified(technicianId: string): Promise<boolean> {
    return this.verificationRepository.exists({
      where: {
        technicianId,
        status: VerificationStatus.VERIFIED,
        technician: {
          role: Role.TECHNICIAN,
          status: AccountStatus.ACTIVE,
          isActive: true,
        },
      },
    });
  }

  private async review(
    id: string,
    reviewerId: string,
    status: VerificationStatus,
    rejectionReason: string | null,
  ): Promise<TechnicianVerification> {
    return this.verificationRepository.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(TechnicianVerification);
      const verification = await verifications.findOne({ where: { id } });
      if (!verification)
        throw new NotFoundException('Verification request not found');
      const technician = await manager
        .getRepository(User)
        .findOne({
          where: { id: verification.technicianId },
          lock: { mode: 'pessimistic_write' },
        });
      if (
        !technician ||
        technician.status !== AccountStatus.ACTIVE ||
        !technician.isActive
      )
        throw new ForbiddenException('Technician account is inactive');
      const result = await verifications.update(
        { id, status: VerificationStatus.PENDING },
        {
          status,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason,
        },
      );
      if (result.affected !== 1)
        throw new ConflictException(
          'Verification request is already processed',
        );

      const profileResult = await manager
        .getRepository(TechnicianProfile)
        .update(
          { userId: verification.technicianId },
          { verificationStatus: status },
        );
      if (profileResult.affected !== 1)
        throw new NotFoundException('Technician profile not found');

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.ADMIN,
        action:
          status === VerificationStatus.VERIFIED
            ? 'KYC_VERIFICATION_APPROVED'
            : 'KYC_VERIFICATION_REJECTED',
        resourceType: 'technician_verification',
        resourceId: id,
        before: { status: verification.status },
        after: {
          status,
          profileVerificationStatus: status,
          reviewedById: reviewerId,
          rejectionReason,
        },
      });

      const updated = await verifications.findOne({
        where: { id },
        relations: ['documents', 'technician', 'reviewedBy'],
      });
      if (!updated)
        throw new NotFoundException('Verification request not found');
      return updated;
    });
  }

  async getSignedDocumentAccess(
    documentId: string,
    actor: { id: string; role: Role },
    expectedVerificationId?: string,
  ): Promise<KycSignedAccess> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
      relations: ['verification'],
    });
    if (!document || !document.verification) {
      throw new NotFoundException('Verification document not found');
    }
    if (
      expectedVerificationId &&
      document.verificationId !== expectedVerificationId
    ) {
      throw new NotFoundException('Verification document not found');
    }

    const isAdmin = actor.role === Role.ADMIN;
    const isOwner =
      actor.role === Role.TECHNICIAN &&
      document.verification.technicianId === actor.id;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        'You do not have permission to access this KYC document',
      );
    }
    if (!document.storageObjectPath) {
      throw new NotFoundException(
        'This KYC document has no private storage reference',
      );
    }

    return this.storageService.createSignedAccess(
      document.storageObjectPath,
      document.verification.technicianId,
    );
  }

  private validateSubmissionDocuments(dto: SubmitVerificationDto): void {
    const documents = dto.documents ?? [];
    const hasCitizenId = documents.some(
      (document) =>
        document.documentType === DocumentType.CITIZEN_ID_FRONT ||
        document.documentType === DocumentType.CITIZEN_ID_BACK,
    );
    if (!hasCitizenId)
      throw new BadRequestException(
        'At least one CCCD image is required for verification',
      );

    if (
      !documents.some(
        (document) => document.documentType === DocumentType.FACE_PHOTO,
      )
    )
      throw new BadRequestException('A face photo is required for verification');
  }
}

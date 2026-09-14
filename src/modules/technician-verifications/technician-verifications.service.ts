// src/modules/technician-verifications/technician-verifications.service.ts
import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
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
import { ConfigService } from '@nestjs/config';
import { PaginationMeta } from '../../shared/dto';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  SubmitVerificationDto,
  RejectVerificationDto,
  QueryVerificationsDto,
} from './dto';

@Injectable()
export class TechnicianVerificationsService {
  constructor(
    @InjectRepository(TechnicianVerification)
    private readonly verificationRepository: Repository<TechnicianVerification>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async submitVerification(
    technicianId: string,
    dto: SubmitVerificationDto,
  ): Promise<TechnicianVerification> {
    this.validateSubmissionDocuments(dto);

    const cloud = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    if (!cloud)
      throw new ServiceUnavailableException(
        'Verification storage is not configured',
      );
    const extensions: Record<string, string[]> = {
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/webp': ['webp'],
      'application/pdf': ['pdf'],
    };
    for (const doc of dto.documents) {
      const url = new URL(doc.fileUrl);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'res.cloudinary.com' ||
        url.pathname.split('/')[1] !== cloud ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new BadRequestException(
          'Document must belong to configured Cloudinary storage',
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
    return this.verificationRepository.manager.transaction(async (manager) => {
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
          fileUrl: doc.fileUrl,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          mimeType: doc.mimeType,
        }),
      );

      savedVerification.documents = await documentRepository.save(documents);
      return savedVerification;
    });
  }

  async getMyVerification(
    technicianId: string,
  ): Promise<TechnicianVerification | null> {
    return this.verificationRepository.findOne({
      where: { technicianId },
      order: { submittedAt: 'DESC' },
      relations: ['documents'],
    });
  }

  async findAll(
    query: QueryVerificationsDto,
  ): Promise<{ data: TechnicianVerification[]; meta: PaginationMeta }> {
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

    return { data, meta };
  }

  async findById(id: string): Promise<TechnicianVerification> {
    const verification = await this.verificationRepository.findOne({
      where: { id },
      relations: ['technician', 'documents', 'reviewedBy'],
    });

    if (!verification) {
      throw new NotFoundException(
        `Verification request with ID ${id} not found`,
      );
    }

    return verification;
  }

  async approveVerification(
    id: string,
    reviewerId: string,
  ): Promise<TechnicianVerification> {
    return this.review(id, reviewerId, VerificationStatus.VERIFIED, null);
  }

  async rejectVerification(
    id: string,
    reviewerId: string,
    dto: RejectVerificationDto,
  ): Promise<TechnicianVerification> {
    if (!dto.rejectionReason || dto.rejectionReason.trim().length < 5)
      throw new BadRequestException('Rejection reason is required');
    return this.review(
      id,
      reviewerId,
      VerificationStatus.REJECTED,
      dto.rejectionReason.trim(),
    );
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

      await this.auditLogService.logWithManager(manager, {
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

// src/modules/technician-verifications/technician-verifications.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TechnicianVerificationsService } from './technician-verifications.service';
import { TechnicianVerification } from './entities/technician-verification.entity';
import { VerificationStatus, DocumentType } from '../../shared/enums';
import { Role, AccountStatus } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { VerificationDocument } from './entities/verification-document.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { KycStorageService } from './kyc-storage.service';

describe('TechnicianVerificationsService', () => {
  let verificationsService: TechnicianVerificationsService;
  let verificationRepository: any;
  let documentRepository: any;
  let profileRepository: any;
  let auditLogService: any;
  let storageService: any;
  let manager: any;

  const mockVerification: TechnicianVerification = {
    id: 'verif-uuid-1',
    technicianId: 'tech-uuid-1',
    technician: {} as any,
    status: VerificationStatus.PENDING,
    submittedAt: new Date(),
    reviewedAt: null,
    reviewedById: null,
    reviewedBy: null,
    rejectionReason: null,
    documents: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    verificationRepository = {
      findOne: vi.fn(),
      create: vi
        .fn()
        .mockImplementation((d) => ({ ...mockVerification, ...d })),
      save: vi.fn().mockImplementation((d) => Promise.resolve({ ...d })),
      createQueryBuilder: vi.fn().mockReturnValue({
        leftJoinAndSelect: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        take: vi.fn().mockReturnThis(),
        getManyAndCount: vi.fn().mockResolvedValue([[mockVerification], 1]),
      }),
    };

    documentRepository = {
      findOne: vi.fn(),
      create: vi.fn().mockImplementation((d) => ({ id: 'doc-uuid', ...d })),
      save: vi.fn().mockImplementation((d) => Promise.resolve(d)),
    };
    profileRepository = {
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };
    auditLogService = {
      logWithManager: vi.fn().mockResolvedValue(undefined),
      logWithManagerStrict: vi.fn().mockResolvedValue(undefined),
    };
    storageService = {
      validateObjectPath: vi.fn(),
      createSignedAccess: vi.fn().mockResolvedValue({
        signedUrl: 'https://project.supabase.co/signed/kyc-document',
        expiresIn: 300,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      createSignedUploadUrl: vi.fn().mockResolvedValue({
        storageObjectPath: 'kyc/tech-uuid-1/generated-id.jpg',
        uploadUrl:
          'https://project.supabase.co/storage/v1/object/upload/sign/kyc-private/kyc/tech-uuid-1/generated-id.jpg?token=opaque',
        token: 'opaque',
        expiresIn: 7200,
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    };

    verificationRepository.update = vi.fn(async (_criteria, changes) => {
      const current = await verificationRepository.findOne();
      if (current.status !== VerificationStatus.PENDING) return { affected: 0 };
      verificationRepository.findOne.mockResolvedValue({
        ...current,
        ...changes,
      });
      return { affected: 1 };
    });
    const users = {
      findOne: vi
        .fn()
        .mockResolvedValue({
          role: Role.TECHNICIAN,
          status: AccountStatus.ACTIVE,
          isActive: true,
        }),
    };
    manager = {
      getRepository: (entity: unknown) =>
        entity === User
          ? users
          : entity === VerificationDocument
            ? documentRepository
            : entity === TechnicianProfile
              ? profileRepository
            : verificationRepository,
    };
    verificationRepository.manager = {
      transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
      getRepository: (entity: unknown) => manager.getRepository(entity),
    };

    verificationsService = new TechnicianVerificationsService(
      verificationRepository,
      documentRepository,
      auditLogService,
      storageService as KycStorageService,
    );
  });

  const validDocuments = [
    {
      documentType: DocumentType.CITIZEN_ID_FRONT,
      storageObjectPath: 'kyc/tech-uuid-1/id-front.jpg',
      fileName: 'id_front.jpg',
      fileSize: 500000,
      mimeType: 'image/jpeg',
    },
    {
      documentType: DocumentType.FACE_PHOTO,
      storageObjectPath: 'kyc/tech-uuid-1/face-photo.jpg',
      fileName: 'face_photo.jpg',
      fileSize: 500000,
      mimeType: 'image/jpeg',
    },
  ];

  describe('submitVerification', () => {
    it('submits verification request with document metadata successfully', async () => {
      verificationRepository.findOne.mockResolvedValue(null);

      const result = await verificationsService.submitVerification(
        'tech-uuid-1',
        {
          documents: validDocuments,
        },
      );

      expect(result.status).toBe(VerificationStatus.PENDING);
      expect(result.technicianId).toBe('tech-uuid-1');
      expect(documentRepository.save).toHaveBeenCalled();
      expect(documentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          storageObjectPath: 'kyc/tech-uuid-1/id-front.jpg',
        }),
      );
      expect(documentRepository.create.mock.calls[0][0]).not.toHaveProperty(
        'fileUrl',
      );
    });

    it('rejects submission when no CCCD image is provided', async () => {
      verificationRepository.findOne.mockResolvedValue(null);

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: [validDocuments[1]],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects submission when no face photo is provided', async () => {
      verificationRepository.findOne.mockResolvedValue(null);

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: [validDocuments[0]],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a CCCD image together with a face photo', async () => {
      verificationRepository.findOne.mockResolvedValue(null);

      const result = await verificationsService.submitVerification(
        'tech-uuid-1',
        { documents: validDocuments },
      );

      expect(result.documents).toHaveLength(2);
    });

    it('rejects submission if a request is already PENDING', async () => {
      verificationRepository.findOne.mockResolvedValueOnce(mockVerification);

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: validDocuments,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects submission if technician is already VERIFIED', async () => {
      verificationRepository.findOne
        .mockResolvedValueOnce(null) // pending check
        .mockResolvedValueOnce({
          ...mockVerification,
          status: VerificationStatus.VERIFIED,
        }); // verified check

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: validDocuments,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a public URL instead of a private object reference', async () => {
      verificationRepository.findOne.mockResolvedValue(null);
      storageService.validateObjectPath.mockImplementation(() => {
        throw new BadRequestException('Invalid private KYC storage object path');
      });

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: [
            {
              ...validDocuments[0],
              storageObjectPath:
                'https://project.supabase.co/storage/v1/object/public/kyc/id.jpg',
            },
            validDocuments[1],
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('keeps MIME and filename extension validation', async () => {
      verificationRepository.findOne.mockResolvedValue(null);

      await expect(
        verificationsService.submitVerification('tech-uuid-1', {
          documents: [
            { ...validDocuments[0], fileName: 'id-front.pdf' },
            validDocuments[1],
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createDocumentUploadUrl', () => {
    it('issues an upload URL for an active technician', async () => {
      const result = await verificationsService.createDocumentUploadUrl(
        'tech-uuid-1',
        { mimeType: 'image/jpeg' },
      );

      expect(storageService.createSignedUploadUrl).toHaveBeenCalledWith(
        'tech-uuid-1',
        'image/jpeg',
      );
      expect(result.storageObjectPath).toBe('kyc/tech-uuid-1/generated-id.jpg');
    });

    it('rejects when the technician account is not active', async () => {
      const users = { findOne: vi.fn().mockResolvedValue(null) };
      verificationRepository.manager.getRepository = (entity: unknown) =>
        entity === User ? users : manager.getRepository(entity);

      await expect(
        verificationsService.createDocumentUploadUrl('tech-uuid-1', {
          mimeType: 'image/jpeg',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(storageService.createSignedUploadUrl).not.toHaveBeenCalled();
    });
  });

  describe('signed document access', () => {
    const document = {
      id: 'doc-uuid-1',
      verificationId: 'verif-uuid-1',
      storageObjectPath: 'kyc/tech-uuid-1/id-front.jpg',
      verification: { technicianId: 'tech-uuid-1' },
    };

    beforeEach(() => {
      documentRepository.findOne.mockResolvedValue(document);
    });

    it('allows an Admin and signs the stored private object path', async () => {
      const result = await verificationsService.getSignedDocumentAccess(
        'doc-uuid-1',
        { id: 'admin-uuid-1', role: Role.ADMIN },
        'verif-uuid-1',
      );

      expect(storageService.createSignedAccess).toHaveBeenCalledWith(
        document.storageObjectPath,
        'tech-uuid-1',
      );
      expect(result.signedUrl).toContain('supabase.co');
      expect(JSON.stringify(result)).not.toContain('service-role');
    });

    it('allows only the Technician owner', async () => {
      await expect(
        verificationsService.getSignedDocumentAccess('doc-uuid-1', {
          id: 'tech-uuid-1',
          role: Role.TECHNICIAN,
        }),
      ).resolves.toBeDefined();

      await expect(
        verificationsService.getSignedDocumentAccess('doc-uuid-1', {
          id: 'other-tech-uuid',
          role: Role.TECHNICIAN,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies Customer access to private KYC media', async () => {
      await expect(
        verificationsService.getSignedDocumentAccess('doc-uuid-1', {
          id: 'customer-uuid-1',
          role: Role.CUSTOMER,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('approveVerification', () => {
    it('approves verification request and records audit fields', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.PENDING,
      });

      const result = await verificationsService.approveVerification(
        'verif-uuid-1',
        'admin-uuid-1',
      );

      expect(result.status).toBe(VerificationStatus.VERIFIED);
      expect(result.reviewedById).toBe('admin-uuid-1');
      expect(result.reviewedAt).toBeInstanceOf(Date);
      expect(result.rejectionReason).toBeNull();
      expect(profileRepository.update).toHaveBeenCalledWith(
        { userId: 'tech-uuid-1' },
        { verificationStatus: VerificationStatus.VERIFIED },
      );
      expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          actorUserId: 'admin-uuid-1',
          action: 'KYC_VERIFICATION_APPROVED',
          resourceType: 'technician_verification',
          resourceId: 'verif-uuid-1',
          before: { status: VerificationStatus.PENDING },
          after: {
            status: VerificationStatus.VERIFIED,
            profileVerificationStatus: VerificationStatus.VERIFIED,
            reviewedById: 'admin-uuid-1',
            rejectionReason: null,
          },
        }),
      );
    });

    it('throws ConflictException if already processed', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.VERIFIED,
      });

      await expect(
        verificationsService.approveVerification(
          'verif-uuid-1',
          'admin-uuid-1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('rejectVerification', () => {
    it('rejects verification request with reason', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.PENDING,
      });

      const result = await verificationsService.rejectVerification(
        'verif-uuid-1',
        'admin-uuid-1',
        { rejectionReason: 'ID card image is blurry' },
      );

      expect(result.status).toBe(VerificationStatus.REJECTED);
      expect(result.rejectionReason).toBe('ID card image is blurry');
      expect(result.reviewedById).toBe('admin-uuid-1');
      expect(profileRepository.update).toHaveBeenCalledWith(
        { userId: 'tech-uuid-1' },
        { verificationStatus: VerificationStatus.REJECTED },
      );
      expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          actorUserId: 'admin-uuid-1',
          action: 'KYC_VERIFICATION_REJECTED',
          resourceId: 'verif-uuid-1',
          after: expect.objectContaining({
            status: VerificationStatus.REJECTED,
            profileVerificationStatus: VerificationStatus.REJECTED,
            rejectionReason: 'ID card image is blurry',
          }),
        }),
      );
    });

    it('throws ConflictException if already rejected', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.REJECTED,
      });

      await expect(
        verificationsService.rejectVerification(
          'verif-uuid-1',
          'admin-uuid-1',
          {
            rejectionReason: 'Already rejected',
          },
        ),
        ).rejects.toThrow(ConflictException);
      expect(profileRepository.update).not.toHaveBeenCalled();
      expect(auditLogService.logWithManagerStrict).not.toHaveBeenCalled();
    });
  });

  describe('strict KYC audit', () => {
    it('fails approve when the strict audit insert fails instead of silently succeeding', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.PENDING,
      });
      auditLogService.logWithManagerStrict.mockRejectedValueOnce(
        new Error('audit insert failed'),
      );

      await expect(
        verificationsService.approveVerification('verif-uuid-1', 'admin-uuid-1'),
      ).rejects.toThrow('audit insert failed');
    });

    it('fails reject when the strict audit insert fails instead of silently succeeding', async () => {
      verificationRepository.findOne.mockResolvedValue({
        ...mockVerification,
        status: VerificationStatus.PENDING,
      });
      auditLogService.logWithManagerStrict.mockRejectedValueOnce(
        new Error('audit insert failed'),
      );

      await expect(
        verificationsService.rejectVerification(
          'verif-uuid-1',
          'admin-uuid-1',
          { rejectionReason: 'ID card image is blurry' },
        ),
      ).rejects.toThrow('audit insert failed');
    });
  });

  describe('isVerified', () => {
    it('uses VERIFIED as the matching eligibility status', async () => {
      verificationRepository.exists = vi.fn().mockResolvedValue(true);

      await expect(
        verificationsService.isVerified('tech-uuid-1'),
      ).resolves.toBe(true);

      expect(verificationRepository.exists).toHaveBeenCalledWith({
        where: expect.objectContaining({
          technicianId: 'tech-uuid-1',
          status: VerificationStatus.VERIFIED,
        }),
      });
    });
  });
});

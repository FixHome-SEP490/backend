import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AdminTechnicianVerificationsController } from './admin-technician-verifications.controller';
import { TechnicianVerificationsController } from './technician-verifications.controller';
import {
  KycSignedAccessResponseDto,
  TechnicianVerificationResponseDto,
  VerificationDocumentResponseDto,
} from './dto/technician-verification-response.dto';
import { toTechnicianVerificationResponse } from './technician-verifications.mapper';

describe('Technician verification safe response projection', () => {
  it('removes private storage references and sensitive User fields', () => {
    const response = toTechnicianVerificationResponse({
      id: 'verification-1',
      technicianId: 'technician-1',
      status: 'pending',
      submittedAt: new Date('2026-09-15T00:00:00.000Z'),
      reviewedAt: null,
      reviewedById: null,
      rejectionReason: null,
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
      updatedAt: new Date('2026-09-15T00:00:00.000Z'),
      technician: {
        id: 'technician-1',
        email: 'tech@example.com',
        passwordHash: 'must-not-leak',
        fullName: 'Technician One',
        phoneNumber: '+84123456789',
        role: 'technician',
        status: 'active',
        isActive: true,
        avatarUrl: null,
        bookingSuspendedUntil: null,
        refreshTokens: [{ tokenHash: 'must-not-leak' }],
      },
      reviewedBy: null,
      documents: [
        {
          id: 'document-1',
          verificationId: 'verification-1',
          documentType: 'citizen_id_front',
          storageObjectPath: 'kyc/technician-1/id.jpg',
          legacyFileUrl: 'https://legacy.example.com/id.jpg',
          fileName: 'id.jpg',
          fileSize: 1024,
          mimeType: 'image/jpeg',
          createdAt: new Date('2026-09-15T00:00:00.000Z'),
          updatedAt: new Date('2026-09-15T00:00:00.000Z'),
        },
      ],
    } as never);

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('storageObjectPath');
    expect(serialized).not.toContain('legacyFileUrl');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('refreshTokens');
    expect(serialized).not.toContain('phoneNumber');
    expect(response.documents[0]).toEqual(
      expect.objectContaining({
        id: 'document-1',
        documentType: 'citizen_id_front',
        fileName: 'id.jpg',
        fileSize: 1024,
        mimeType: 'image/jpeg',
      }),
    );
  });

  it('documents safe verification and private signed-access response types', () => {
    const selfStatus = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      TechnicianVerificationsController.prototype.getMyVerification,
    );
    const submit = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      TechnicianVerificationsController.prototype.submit,
    );
    const access = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminTechnicianVerificationsController.prototype.getDocumentAccess,
    );
    const adminList = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminTechnicianVerificationsController.prototype.findAll,
    );

    const selfSchema = selfStatus['200'].schema;
    expect(selfSchema).toMatchObject({
      type: 'object',
      nullable: true,
      required: expect.arrayContaining([
        'id',
        'technicianId',
        'status',
        'submittedAt',
        'reviewedAt',
        'reviewedById',
        'rejectionReason',
        'documents',
        'createdAt',
        'updatedAt',
      ]),
    });
    expect(selfSchema).not.toHaveProperty('allOf');
    expect(selfSchema).not.toHaveProperty('oneOf');
    expect(selfSchema).not.toHaveProperty('$ref');
    expect(selfSchema.properties).toMatchObject({
      id: { type: 'string', format: 'uuid' },
      technicianId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: expect.any(Array) },
      submittedAt: { type: 'string', format: 'date-time' },
      reviewedAt: { type: 'string', format: 'date-time', nullable: true },
      reviewedById: { type: 'string', format: 'uuid', nullable: true },
      rejectionReason: { type: 'string', nullable: true },
      documents: { type: 'array' },
      technician: { type: 'object' },
      reviewedBy: { type: 'object', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
    expect(selfSchema.properties.documents.items).toMatchObject({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        documentType: { type: 'string', enum: expect.any(Array) },
        fileName: { type: 'string' },
      },
    });
    expect(submit['201']).toMatchObject({
      type: TechnicianVerificationResponseDto,
    });
    expect(access['200']).toMatchObject({ type: KycSignedAccessResponseDto });
    expect(adminList['200']).toMatchObject({
      type: TechnicianVerificationResponseDto,
      isArray: true,
    });

    const documentProperties = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      VerificationDocumentResponseDto.prototype,
      'fileName',
    );
    expect(documentProperties).toBeDefined();
    expect(
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        VerificationDocumentResponseDto.prototype,
        'storageObjectPath',
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        VerificationDocumentResponseDto.prototype,
        'legacyFileUrl',
      ),
    ).toBeUndefined();
  });
});

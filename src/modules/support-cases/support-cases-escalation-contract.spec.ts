import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role, SupportCaseType } from '../../shared/enums';
import { SupportCasesController } from './support-cases.controller';
import { CreateSupportCaseDto, SupportCaseDetailDto } from './dto';

const validPayload = (): Record<string, unknown> => ({
  caseType: SupportCaseType.CASH_MISMATCH,
  reason: 'The declared cash amount does not match my invoice',
  description: 'The technician declared 119000 VND instead of 120000 VND.',
  evidenceRefs: ['storage://support/case-1/photo-1'],
  bookingId: '11111111-1111-4111-8111-111111111111',
  serviceOrderId: '22222222-2222-4222-8222-222222222222',
});

describe('Support escalation API contract metadata', () => {
  it('restricts POST /support/cases to customer/technician with a shared read permission', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, SupportCasesController.prototype.create),
    ).toEqual([Role.CUSTOMER, Role.TECHNICIAN]);
    expect(
      Reflect.getMetadata(
        PERMISSION_KEY,
        SupportCasesController.prototype.create,
      ),
    ).toEqual(['order:read_related']);
  });

  it('documents a typed 201 response with 400/401/403/404 behavior', () => {
    const responses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.create,
    );
    expect(responses['201']).toMatchObject({
      type: SupportCaseDetailDto,
      isArray: false,
    });
    for (const status of ['400', '401', '403', '404']) {
      expect(responses[status]).toBeDefined();
    }
  });

  it('validates the bounded escalation DTO contract', async () => {
    const valid = Object.assign(new CreateSupportCaseDto(), validPayload());
    expect(await validate(valid)).toEqual([]);

    const missingContext = Object.assign(new CreateSupportCaseDto(), {
      caseType: SupportCaseType.OTHER,
      reason: 'Free-floating escalation without context',
    });
    expect(await validate(missingContext)).toEqual([]);

    const invalid = Object.assign(new CreateSupportCaseDto(), {
      caseType: 'not_a_case_type',
      reason: '',
      description: '',
      evidenceRefs: Array.from({ length: 21 }, () => 'opaque-ref'),
      bookingId: 'not-a-uuid',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining([
        'caseType',
        'reason',
        'description',
        'evidenceRefs',
        'bookingId',
      ]),
    );
  });

  it('rejects client-supplied owner/manager/resolution/financial/state fields', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    });

    await expect(
      pipe.transform(
        {
          ...validPayload(),
          customerId: '33333333-3333-4333-8333-333333333333',
          technicianId: '44444444-4444-4434-8344-444444444444',
          createdByUserId: '55555555-5555-4555-8555-555555555555',
          assignedManagerId: '66666666-6666-4666-8666-666666666666',
          status: 'resolved',
          resolutionCode: 'FORGED',
          resolutionReason: 'Forged manager resolution',
          dueAmount: 999999,
          paymentStatus: 'paid',
        },
        { type: 'body', metatype: CreateSupportCaseDto },
      ),
    ).rejects.toThrow();
  });

  it('keeps manager/admin read and resolve contracts unchanged', () => {
    expect(Reflect.getMetadata(ROLES_KEY, SupportCasesController)).toEqual([
      Role.SERVICE_MANAGER,
      Role.ADMIN,
    ]);
    expect(
      Reflect.getMetadata(ROLES_KEY, SupportCasesController.prototype.resolve),
    ).toEqual([Role.SERVICE_MANAGER]);
  });
});

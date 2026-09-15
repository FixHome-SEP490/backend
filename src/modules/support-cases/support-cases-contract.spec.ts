import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role, SupportCaseStatus } from '../../shared/enums';
import { SupportCasesController } from './support-cases.controller';
import {
  QuerySupportCasesDto,
  ResolveSupportCaseDto,
  SupportCaseDetailDto,
  SupportCaseSummaryDto,
} from './dto';

describe('Support case API contract metadata', () => {
  it('allows only manager/admin reads and manager-only resolution', () => {
    expect(Reflect.getMetadata(ROLES_KEY, SupportCasesController)).toEqual([
      Role.SERVICE_MANAGER,
      Role.ADMIN,
    ]);
    expect(Reflect.getMetadata(PERMISSION_KEY, SupportCasesController)).toEqual(
      ['support:read_all'],
    );
    expect(
      Reflect.getMetadata(ROLES_KEY, SupportCasesController.prototype.resolve),
    ).toEqual([Role.SERVICE_MANAGER]);
    expect(
      Reflect.getMetadata(
        PERMISSION_KEY,
        SupportCasesController.prototype.resolve,
      ),
    ).toEqual(['support:resolve']);
  });

  it('documents inner list/detail/resolve DTOs and important errors', () => {
    const listResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.findAll,
    );
    const detailResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.findOne,
    );
    const resolveResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SupportCasesController.prototype.resolve,
    );

    expect(listResponses['200']).toMatchObject({
      type: SupportCaseSummaryDto,
      isArray: true,
    });
    expect(detailResponses['200']).toMatchObject({
      type: SupportCaseDetailDto,
      isArray: false,
    });
    expect(resolveResponses['200']).toMatchObject({
      type: SupportCaseDetailDto,
      isArray: false,
    });
    for (const status of ['400', '401', '403']) {
      expect(listResponses[status]).toBeDefined();
      expect(detailResponses[status]).toBeDefined();
    }
    expect(detailResponses['404']).toBeDefined();
    expect(resolveResponses['404']).toBeDefined();
    expect(resolveResponses['409']).toBeDefined();
  });

  it('documents nullable runtime contexts without exposing an entity dump', () => {
    const booking = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      SupportCaseDetailDto.prototype,
      'booking',
    );
    const serviceOrder = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      SupportCaseDetailDto.prototype,
      'serviceOrder',
    );
    expect(booking).toMatchObject({ nullable: true });
    expect(serviceOrder).toMatchObject({ nullable: true });
    expect(booking.type).toBeDefined();
    expect(serviceOrder.type).toBeDefined();
  });

  it('keeps finalization statuses terminal-only', () => {
    expect(SupportCaseStatus.RESOLVED).toBe('resolved');
    expect(SupportCaseStatus.REJECTED).toBe('rejected');
  });

  it('validates bounded finalization input and pagination limits', async () => {
    const invalidResolution = Object.assign(new ResolveSupportCaseDto(), {
      finalStatus: SupportCaseStatus.OPEN,
      resolutionCode: '',
      reason: 'too short',
      evidenceRefs: Array.from({ length: 21 }, () => 'opaque-ref'),
    });
    const resolutionErrors = await validate(invalidResolution);
    expect(resolutionErrors.map((error) => error.property)).toEqual(
      expect.arrayContaining([
        'finalStatus',
        'resolutionCode',
        'reason',
        'evidenceRefs',
      ]),
    );

    const invalidQuery = Object.assign(new QuerySupportCasesDto(), {
      limit: 101,
    });
    const queryErrors = await validate(invalidQuery);
    expect(queryErrors.map((error) => error.property)).toContain('limit');
  });
});

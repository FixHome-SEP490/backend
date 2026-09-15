import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AdminAuditLogController } from './admin-audit-log.controller';
import { AuditLogResponseDto } from './dto/audit-log-response.dto';

describe('Audit log API contract metadata', () => {
  it('documents paginated list and detail payloads as inner audit DTOs', () => {
    const listResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminAuditLogController.prototype.findAll,
    );
    const detailResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminAuditLogController.prototype.findOne,
    );

    expect(listResponses['200']).toMatchObject({
      type: AuditLogResponseDto,
      isArray: true,
    });
    expect(detailResponses['200']).toMatchObject({
      type: AuditLogResponseDto,
      isArray: false,
    });
  });

  it('keeps the important audit query and detail errors documented', () => {
    const listResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminAuditLogController.prototype.findAll,
    );
    const detailResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminAuditLogController.prototype.findOne,
    );

    for (const status of ['400', '401', '403']) {
      expect(listResponses[status]).toBeDefined();
      expect(detailResponses[status]).toBeDefined();
    }
    expect(detailResponses['404']).toBeDefined();
  });

  it('models before and after as nullable opaque JSON objects', () => {
    const before = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      AuditLogResponseDto.prototype,
      'before',
    );
    const after = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      AuditLogResponseDto.prototype,
      'after',
    );

    expect(before).toMatchObject({
      type: 'object',
      nullable: true,
      additionalProperties: true,
    });
    expect(after).toMatchObject({
      type: 'object',
      nullable: true,
      additionalProperties: true,
    });
  });
});

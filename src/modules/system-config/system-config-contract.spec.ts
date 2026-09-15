import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AdminConfigController } from './admin-config.controller';
import { SystemConfigResponseDto } from './dto/system-config-response.dto';

describe('System config API contract metadata', () => {
  it('documents list, detail, and update payloads with the inner response DTO', () => {
    const listResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminConfigController.prototype.findAll,
    );
    const detailResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminConfigController.prototype.findOne,
    );
    const updateResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminConfigController.prototype.update,
    );

    expect(listResponses['200']).toMatchObject({
      type: SystemConfigResponseDto,
      isArray: true,
    });
    expect(detailResponses['200']).toMatchObject({
      type: SystemConfigResponseDto,
      isArray: false,
    });
    expect(updateResponses['200']).toMatchObject({
      type: SystemConfigResponseDto,
      isArray: false,
    });
  });

  it('keeps the important admin error statuses documented', () => {
    for (const handler of [
      AdminConfigController.prototype.findAll,
      AdminConfigController.prototype.findOne,
      AdminConfigController.prototype.update,
    ]) {
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler);
      expect(responses['400']).toBeDefined();
      expect(responses['401']).toBeDefined();
      expect(responses['403']).toBeDefined();
    }

    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminConfigController.prototype.findOne,
      )['404'],
    ).toBeDefined();
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminConfigController.prototype.update,
      )['404'],
    ).toBeDefined();
  });
});

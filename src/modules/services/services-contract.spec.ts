import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AdminServicesController } from './admin-services.controller';
import { ServicesController } from './services.controller';
import {
  ServiceCategorySummaryResponseDto,
  ServiceResponseDto,
} from './dto/service-response.dto';

describe('Service catalog API contract metadata', () => {
  it('documents every public and admin success payload with the inner service DTO', () => {
    const arrayHandlers = [
      ServicesController.prototype.findServices,
      AdminServicesController.prototype.findAll,
    ];
    for (const handler of arrayHandlers) {
      expect(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)['200'],
      ).toMatchObject({ type: ServiceResponseDto, isArray: true });
    }

    const detailHandlers = [
      ServicesController.prototype.findByIdOrSlug,
      AdminServicesController.prototype.findById,
      AdminServicesController.prototype.deactivate,
      AdminServicesController.prototype.update,
      AdminServicesController.prototype.toggleStatus,
    ];
    for (const handler of detailHandlers) {
      expect(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)['200'],
      ).toMatchObject({ type: ServiceResponseDto, isArray: false });
    }

    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminServicesController.prototype.create,
      )['201'],
    ).toMatchObject({ type: ServiceResponseDto, isArray: false });
  });

  it('documents public and admin error contracts', () => {
    const publicList = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      ServicesController.prototype.findServices,
    );
    const publicDetail = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      ServicesController.prototype.findByIdOrSlug,
    );
    expect(publicList['400']).toBeDefined();
    expect(publicDetail['404']).toBeDefined();

    for (const handler of [
      AdminServicesController.prototype.findAll,
      AdminServicesController.prototype.findById,
      AdminServicesController.prototype.create,
      AdminServicesController.prototype.update,
      AdminServicesController.prototype.toggleStatus,
      AdminServicesController.prototype.deactivate,
    ]) {
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler);
      expect(responses['400']).toBeDefined();
      expect(responses['401']).toBeDefined();
      expect(responses['403']).toBeDefined();
    }
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminServicesController.prototype.findById,
      )['404'],
    ).toBeDefined();
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminServicesController.prototype.create,
      )['409'],
    ).toBeDefined();
  });

  it('uses a category summary without a recursive services property', () => {
    const category = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      ServiceResponseDto.prototype,
      'category',
    );
    expect(category.type).toBe(ServiceCategorySummaryResponseDto);
    expect(
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        ServiceCategorySummaryResponseDto.prototype,
        'services',
      ),
    ).toBeUndefined();
  });
});

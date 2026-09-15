import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AdminCategoriesController } from './admin-categories.controller';
import { CategoriesController } from './categories.controller';
import {
  CategoryResponseDto,
  CategoryServiceSummaryResponseDto,
} from './dto/category-response.dto';

describe('Category catalog API contract metadata', () => {
  it('documents public and admin success payloads with the category DTO', () => {
    for (const handler of [
      CategoriesController.prototype.findAll,
      AdminCategoriesController.prototype.findAll,
    ]) {
      expect(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)['200'],
      ).toMatchObject({ type: CategoryResponseDto, isArray: true });
    }

    for (const handler of [
      CategoriesController.prototype.findByIdOrSlug,
      AdminCategoriesController.prototype.deactivate,
      AdminCategoriesController.prototype.update,
      AdminCategoriesController.prototype.toggleStatus,
    ]) {
      expect(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)['200'],
      ).toMatchObject({ type: CategoryResponseDto, isArray: false });
    }

    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminCategoriesController.prototype.create,
      )['201'],
    ).toMatchObject({ type: CategoryResponseDto, isArray: false });
  });

  it('documents important public and admin errors', () => {
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        CategoriesController.prototype.findByIdOrSlug,
      )['404'],
    ).toBeDefined();

    for (const handler of [
      AdminCategoriesController.prototype.findAll,
      AdminCategoriesController.prototype.deactivate,
      AdminCategoriesController.prototype.create,
      AdminCategoriesController.prototype.update,
      AdminCategoriesController.prototype.toggleStatus,
    ]) {
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler);
      expect(responses['401']).toBeDefined();
      expect(responses['403']).toBeDefined();
    }
    for (const handler of [
      AdminCategoriesController.prototype.deactivate,
      AdminCategoriesController.prototype.create,
      AdminCategoriesController.prototype.update,
      AdminCategoriesController.prototype.toggleStatus,
    ]) {
      expect(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, handler)['400'],
      ).toBeDefined();
    }
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminCategoriesController.prototype.deactivate,
      )['404'],
    ).toBeDefined();
    expect(
      Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        AdminCategoriesController.prototype.create,
      )['409'],
    ).toBeDefined();
  });

  it('uses a service summary that does not recurse back to category', () => {
    const services = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CategoryResponseDto.prototype,
      'services',
    );
    expect(services.type).toBe(CategoryServiceSummaryResponseDto);
    expect(
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        CategoryServiceSummaryResponseDto.prototype,
        'category',
      ),
    ).toBeUndefined();
  });
});

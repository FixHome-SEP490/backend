import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { getMetadataArgsStorage } from 'typeorm';
import { AdminPartsController } from './admin-parts.controller';
import { PartsCatalogController } from './parts-catalog.controller';
import { FixHomePartResponseDto, UpdateFixHomePartDto } from './dto';
import { FixHomePart } from './entities/fixhome-part.entity';

describe('Part catalog API contract metadata', () => {
  it('documents paginated catalog lists as FixHomePartResponseDto arrays', () => {
    const readResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      PartsCatalogController.prototype.findCatalog,
    );
    const adminResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      AdminPartsController.prototype.findAll,
    );

    expect(readResponses['200']).toMatchObject({
      type: FixHomePartResponseDto,
      isArray: true,
    });
    expect(adminResponses['200']).toMatchObject({
      type: FixHomePartResponseDto,
      isArray: true,
    });
  });

  it('documents detail/create/update/status success payloads with the safe response DTO', () => {
    const handlers: Array<[object, string, string]> = [
      [PartsCatalogController.prototype.findActiveById, '200', 'read detail'],
      [AdminPartsController.prototype.findById, '200', 'admin detail'],
      [AdminPartsController.prototype.create, '201', 'create'],
      [AdminPartsController.prototype.update, '200', 'update'],
      [AdminPartsController.prototype.toggleStatus, '200', 'status'],
    ];

    for (const [handler, status, label] of handlers) {
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler);
      expect(responses[status], label).toMatchObject({
        type: FixHomePartResponseDto,
        isArray: false,
      });
    }
  });

  it('documents and validates nullable warrantyDays so Admin can clear optional warranty metadata', async () => {
    const dto = new UpdateFixHomePartDto();
    dto.warrantyDays = null;
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('normalizes the numeric DB price into a number for the documented response contract', () => {
    const column = getMetadataArgsStorage().columns.find(
      (item) =>
        item.target === FixHomePart && item.propertyName === 'sellingPrice',
    );
    const transformer = column?.options.transformer;
    expect(transformer).toBeDefined();
    expect(Array.isArray(transformer)).toBe(false);
    if (!transformer || Array.isArray(transformer)) return;

    expect(transformer.from('185000.00')).toBe(185000);
    expect(transformer.from(195000)).toBe(195000);
    expect(transformer.to(185000)).toBe(185000);
  });
});

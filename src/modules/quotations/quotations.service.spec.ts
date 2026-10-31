// src/modules/quotations/quotations.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuotationsService } from './quotations.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { CostItemType, PartSource, PartWarrantyOption } from '../../shared/enums';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';

describe('QuotationsService - Item Validation & Authoritative Catalog', () => {
  let service: QuotationsService;
  let mockManager: any;

  beforeEach(() => {
    mockManager = {
      findOne: vi.fn(),
    };

    service = new QuotationsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('should enforce authoritative pricing and warranty from FixHome Part Catalog', async () => {
    mockManager.findOne.mockResolvedValueOnce({
      id: 'part-uuid-1',
      name: 'Tụ ngậm điều hòa Daikin 35uF',
      partCode: 'DAIKIN-CAP-35',
      sellingPrice: '180000',
      warrantyDays: 90,
      isActive: true,
    });

    const items = [
      {
        type: CostItemType.PARTS_EQUIPMENT,
        description: 'Thay tụ ngậm chính hãng',
        quantity: 1,
        unitPrice: 999999, // Technician attempted to tamper with price
        partSource: PartSource.FIXHOME,
        partCatalogId: 'part-uuid-1',
        partNameSnapshot: 'Tên linh kiện giả',
        warrantyDays: 1,
        warrantyTermDays: 365,
        partWarrantyOption: PartWarrantyOption.PAID_WARRANTY,
        warrantyFee: 50000,
      },
    ];

    // Access private validateItems for isolated test
    const validated = await (service as any).validateItems(mockManager, items);

    expect(mockManager.findOne).toHaveBeenCalledWith(FixHomePart, {
      where: { id: 'part-uuid-1', isActive: true },
    });
    expect(validated[0].unitPrice).toBe(180000); // Overwritten authoritatively
    expect(validated[0].partNameSnapshot).toBe('Tụ ngậm điều hòa Daikin 35uF');
    expect(validated[0].warrantyDays).toBe(90);
    expect(validated[0].warrantyTermDays).toBe(90);
    expect(validated[0].partWarrantyOption).toBe(PartWarrantyOption.INCLUDED);
    expect(validated[0].warrantyFee).toBe(0);
  });

  it('should reject FixHome part if partCatalogId is missing', async () => {
    const items = [
      {
        type: CostItemType.PARTS_EQUIPMENT,
        description: 'Linh kiện FixHome',
        quantity: 1,
        unitPrice: 100000,
        partSource: PartSource.FIXHOME,
      },
    ];

    await expect((service as any).validateItems(mockManager, items)).rejects.toThrow(
      BusinessException,
    );
  });

  it('should reject technician-owned parts without catalog lookup', async () => {
    const items = [
      {
        type: CostItemType.PARTS_EQUIPMENT,
        description: 'Linh kiện của kỹ thuật viên',
        quantity: 2,
        unitPrice: 120000,
        partSource: PartSource.TECHNICIAN,
        partWarrantyOption: PartWarrantyOption.NO_WARRANTY,
      },
    ];

    await expect((service as any).validateItems(mockManager, items)).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED' },
    });
    expect(mockManager.findOne).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inactive'])('should reject a %s FixHome catalog part', async availability => {
    mockManager.findOne.mockResolvedValueOnce(null);
    const items = [{
      type: CostItemType.PARTS_EQUIPMENT,
      description: 'Linh kiện FixHome',
      quantity: 1,
      unitPrice: 100000,
      partSource: PartSource.FIXHOME,
      partCatalogId: availability === 'missing' ? 'missing-part' : 'inactive-part',
    }];

    await expect((service as any).validateItems(mockManager, items)).rejects.toThrow(BusinessException);
    expect(mockManager.findOne).toHaveBeenCalledWith(FixHomePart, {
      where: { id: items[0].partCatalogId, isActive: true },
    });
  });

  it('should accept labor and keep its configured warranty default and limit', async () => {
    const items = [{ type: CostItemType.LABOR, description: 'Tiền công', quantity: 1, unitPrice: 100000 }];

    const validated = await (service as any).validateItems(mockManager, items, { days: 30, max: 90 });

    expect(validated[0].warrantyDays).toBe(30);
    await expect((service as any).validateItems(mockManager, [{ ...items[0], warrantyDays: 91 }], { days: 30, max: 90 }))
      .rejects.toThrow(BusinessException);
  });
});

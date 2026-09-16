// src/modules/quotations/quotations.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuotationsService } from './quotations.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { CostItemType, PartSource, PartWarrantyOption } from '../../shared/enums';
import { PartCatalog } from '../services/entities/part-catalog.entity';

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
    );
  });

  it('should enforce authoritative pricing and warranty from FixHome Part Catalog', async () => {
    mockManager.findOne.mockResolvedValueOnce({
      id: 'part-uuid-1',
      name: 'Tụ ngậm điều hòa Daikin 35uF',
      partCode: 'DAIKIN-CAP-35',
      price: '180000',
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
      },
    ];

    // Access private validateItems for isolated test
    const validated = await (service as any).validateItems(mockManager, items);

    expect(mockManager.findOne).toHaveBeenCalledWith(PartCatalog, {
      where: { id: 'part-uuid-1', isActive: true },
    });
    expect(validated[0].unitPrice).toBe(180000); // Overwritten authoritatively
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

  it('should validate technician external parts without catalog lookup', async () => {
    const items = [
      {
        type: CostItemType.PARTS_EQUIPMENT,
        description: 'Ống đồng ngoài',
        quantity: 2,
        unitPrice: 120000,
        partSource: PartSource.TECHNICIAN,
        partWarrantyOption: PartWarrantyOption.NO_WARRANTY,
      },
    ];

    const validated = await (service as any).validateItems(mockManager, items);
    expect(mockManager.findOne).not.toHaveBeenCalled();
    expect(validated[0].unitPrice).toBe(120000);
    expect(validated[0].warrantyDays).toBe(0);
    expect(validated[0].partWarrantyOption).toBe(PartWarrantyOption.NO_WARRANTY);
  });
});

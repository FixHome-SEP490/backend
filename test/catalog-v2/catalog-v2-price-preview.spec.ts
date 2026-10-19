import { describe, expect, it } from 'vitest';
import { previewCatalogV2Labor } from '../../src/database/catalog-v2/catalog-v2-price-preview';

describe('Catalog V2 nonbinding S price preview', () => {
  it('requires complete safe evidence instead of accepting a customer variant code', () => {
    expect(previewCatalogV2Labor('AC-02')).toMatchObject({
      status: 'VARIANT_REQUIRED',
      bookable: false,
      priceBinding: false,
    });
    expect(previewCatalogV2Labor('TV-01')).toMatchObject({
      status: 'VARIANT_REQUIRED',
      bookable: false,
      priceBinding: false,
    });
    expect(previewCatalogV2Labor('AC-02', { acHorsepower: 'up_to_1_5' })).toMatchObject({
      status: 'AMBIGUOUS_VARIANT',
      bookable: false,
      priceBinding: false,
    });
  });

  it('derives exact AC tiers only from mounting and horsepower facts', () => {
    expect(previewCatalogV2Labor('AC-02', {
      acMounting: 'wall', acHorsepower: 'up_to_1_5',
    })).toMatchObject({ status: 'FIXED_TIER_PREVIEW', variantCode: 'AC-02-01', laborPriceVnd: 199000 });
    expect(previewCatalogV2Labor('AC-02', {
      acMounting: 'wall', acHorsepower: '2_to_2_5',
    })).toMatchObject({ status: 'FIXED_TIER_PREVIEW', variantCode: 'AC-02-02', laborPriceVnd: 219000 });
    expect(previewCatalogV2Labor('AC-02', { acMounting: 'ceiling' })).toMatchObject({
      status: 'FIXED_TIER_PREVIEW', variantCode: 'AC-02-03', laborPriceVnd: 449000,
    });
  });

  it('derives exact washer tiers only from loading style and capacity', () => {
    const cases = [
      [{ washerLoadingStyle: 'top', washerCapacityKg: 9 }, 'WM-02-05', 399000],
      [{ washerLoadingStyle: 'top', washerCapacityKg: 9.1 }, 'WM-02-06', 449000],
      [{ washerLoadingStyle: 'front', washerCapacityKg: 9 }, 'WM-02-07', 599000],
      [{ washerLoadingStyle: 'front', washerCapacityKg: 9.1 }, 'WM-02-08', 699000],
    ] as const;
    for (const [attributes, variantCode, laborPriceVnd] of cases) {
      expect(previewCatalogV2Labor('WM-02', attributes)).toMatchObject({
        status: 'FIXED_TIER_PREVIEW', variantCode, laborPriceVnd,
      });
    }
  });

  it('never makes inspection references, unknown services, or staged prices bookable', () => {
    expect(previewCatalogV2Labor('WM-01')).toMatchObject({
      status: 'INSPECTION_REQUIRED',
      referenceLaborVnd: 249000,
      bookable: false,
      priceBinding: false,
    });
    expect(previewCatalogV2Labor('KT-05')).toMatchObject({
      status: 'INSPECTION_REQUIRED', activationGate: 'GATE', bookable: false,
    });
    expect(previewCatalogV2Labor('KT-04')).toMatchObject({
      activationGate: 'LATER', bookable: false,
    });
    expect(previewCatalogV2Labor('NOT_IN_CATALOG')).toEqual({
      status: 'UNKNOWN_SERVICE', bookable: false, priceBinding: false,
    });
  });

  it('rejects invalid and service-mismatched input before an inspection reference', () => {
    const injectedPrice = previewCatalogV2Labor('WM-01', { laborPriceVnd: 1 });
    const wrongFamily = previewCatalogV2Labor('WM-01', { acMounting: 'wall' });
    const validReference = previewCatalogV2Labor('WM-01', { brand: 'LG' });

    expect(injectedPrice).toMatchObject({
      status: 'INVALID_DEVICE_ATTRIBUTES', bookable: false, priceBinding: false,
    });
    expect(injectedPrice).not.toHaveProperty('referenceLaborVnd');
    expect(wrongFamily).toMatchObject({
      status: 'INVALID_DEVICE_ATTRIBUTES', bookable: false, priceBinding: false,
    });
    expect(wrongFamily).not.toHaveProperty('referenceLaborVnd');
    expect(validReference).toMatchObject({
      status: 'INSPECTION_REQUIRED', referenceLaborVnd: 249000,
      bookable: false, priceBinding: false,
    });
  });

  it('marks every preview result as non-bookable and non-binding', () => {
    const previews = [
      previewCatalogV2Labor('AC-02', { acMounting: 'wall', acHorsepower: 'up_to_1_5' }),
      previewCatalogV2Labor('AC-02'),
      previewCatalogV2Labor('WM-01'),
      previewCatalogV2Labor('WM-01', { laborPriceVnd: 1 }),
      previewCatalogV2Labor('NOT_IN_CATALOG'),
    ];

    for (const preview of previews) {
      expect(preview).toMatchObject({ bookable: false, priceBinding: false });
    }
  });
});

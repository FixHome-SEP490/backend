import { describe, expect, it } from 'vitest';
import { CATALOG_V2_APPROVED_FIXED_TIERS as tiers } from '../../src/database/catalog-v2/catalog-v2-approved-price-tiers';
import { resolveCatalogV2PricingFromRows } from '../../src/database/catalog-v2/catalog-v2-pricing-binding';

const rows = tiers.map((t, i) => ({ id: `variant-${i}`, service_id: 'service', variant_code: t.variantCode,
  fixed_labor_price_vnd: String(t.laborPriceVnd), included_scope: t.conditionVi, excluded_scope: null, is_active: true }));
const resolve = (code: string, input = {}, dbRows = rows) => resolveCatalogV2PricingFromRows('service', code, input, dbRows);

describe('Catalog V2 authoritative price binding', () => {
  it.each([
    ['AC-02', { acMounting: 'wall', acHorsepower: 'up_to_1_5' }, 'AC-02-01', 199000],
    ['AC-02', { acMounting: 'wall', acHorsepower: '2_to_2_5' }, 'AC-02-02', 219000],
    ['WM-02', { washerLoadingStyle: 'top', washerCapacityKg: 9 }, 'WM-02-05', 399000],
    ['WM-02', { washerLoadingStyle: 'top', washerCapacityKg: 9.1 }, 'WM-02-06', 449000],
    ['WM-02', { washerLoadingStyle: 'front', washerCapacityKg: 9 }, 'WM-02-07', 599000],
    ['WM-02', { washerLoadingStyle: 'front', washerCapacityKg: 9.1 }, 'WM-02-08', 699000],
  ])('binds %s only from sufficient facts', (code, deviceAttributes, variantCode, laborPriceVnd) => {
    expect(resolve(code, { deviceAttributes })).toMatchObject({ status: 'FIXED_PRICE', bindingReady: true,
      selectedVariant: { variantCode, laborPriceVnd }, priceBinding: false });
  });

  it('requires explicit standard cassette scope in addition to ceiling mounting', () => {
    expect(resolve('AC-02', { deviceAttributes: { acMounting: 'ceiling' } })).toMatchObject({
      status: 'INSPECTION_REQUIRED', bindingReady: false, selectedVariant: null, priceRange: null });
    expect(resolve('AC-02', { deviceAttributes: { acMounting: 'ceiling' }, selectedVariantCode: 'AC-02-03' }))
      .toMatchObject({ status: 'FIXED_PRICE', selectedVariant: { laborPriceVnd: 449000 } });
  });

  it('requires explicit approved scope for every other fixed tier, including single-tier services', () => {
    for (const tier of tiers.filter(t => !['AC-02', 'WM-02'].includes(t.serviceCode))) {
      expect(resolve(tier.serviceCode)).toMatchObject({ status: 'INSPECTION_REQUIRED', selectedVariant: null });
      expect(resolve(tier.serviceCode, { selectedVariantCode: tier.variantCode })).toMatchObject({
        status: 'FIXED_PRICE', missingAttributes: [], selectedVariant: { variantCode: tier.variantCode, scopeVi: tier.conditionVi, laborPriceVnd: tier.laborPriceVnd } });
    }
  });

  it('does not let a selection substitute missing AC/WM facts', () => {
    for (const [code, selectedVariantCode] of [['AC-02', 'AC-02-01'], ['WM-02', 'WM-02-05']]) {
      expect(resolve(code, { selectedVariantCode })).toMatchObject({ status: 'INSPECTION_REQUIRED', selectedVariant: null });
    }
  });

  it('rejects unknown, foreign, conflicting, inactive, or drifted selected variants', () => {
    expect(() => resolve('AC-02', { selectedVariantCode: 'WM-02-05' })).toThrow();
    expect(() => resolve('AC-02', { selectedVariantCode: 'unknown' })).toThrow();
    expect(() => resolve('AC-02', { selectedVariantCode: 'AC-02-01', variantCode: 'AC-02-02' })).toThrow();
    expect(() => resolve('AC-02', { selectedVariantCode: 'AC-02-01', deviceAttributes: { acMounting: 'wall', acHorsepower: '2_to_2_5' } })).toThrow();
    expect(() => resolve('AC-03', { selectedVariantCode: 'AC-03-04', deviceAttributes: { acMounting: 'ceiling' } })).toThrow();
    for (const change of [{ is_active: false }, { included_scope: 'Other scope' }, { fixed_labor_price_vnd: '1' }, { service_id: 'foreign' }, { excluded_scope: 'Changed scope' }]) {
      const altered = rows.map(r => r.variant_code === 'AC-02-01' ? { ...r, ...change } : r);
      expect(() => resolve('AC-02', { selectedVariantCode: 'AC-02-01' }, altered)).toThrow();
      expect(resolve('AC-02', { deviceAttributes: { acMounting: 'wall', acHorsepower: 'up_to_1_5' } }, altered))
        .toMatchObject({ status: 'INSPECTION_REQUIRED', selectedVariant: null });
    }
  });

  it('shows only grounded nonbinding ranges and no fake default money', () => {
    expect(resolve('AC-02')).toMatchObject({ status: 'INSPECTION_REQUIRED', selectedVariant: null,
      priceRange: { minLaborVnd: 199000, maxLaborVnd: 449000, priceBinding: false, labelVi: 'Giá tham khảo' } });
    expect(resolve('WM-02', { deviceAttributes: { washerLoadingStyle: 'front' } })).toMatchObject({
      priceRange: { minLaborVnd: 599000, maxLaborVnd: 699000 } });
    expect(resolve('RO-02')).toMatchObject({ priceRange: null, messageVi: 'Cần khảo sát để báo giá' });
    expect(resolve('AC-01')).toMatchObject({ selectedVariant: null, priceRange: null, bindingReady: false });
    expect(() => resolve('KT-05')).toThrow();
    expect(() => resolve('AC-02', { deviceAttributes: { washerCapacityKg: 9 } })).toThrow();
    expect(() => resolve('AC-02', { deviceAttributes: { fixedPrice: 1 } })).toThrow();
  });
});

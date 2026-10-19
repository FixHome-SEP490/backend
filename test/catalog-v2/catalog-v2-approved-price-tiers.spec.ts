import { describe, expect, it } from 'vitest';
import { CATALOG_V2_CATEGORIES, CATALOG_V2_SERVICES } from '../../src/database/catalog-v2/catalog-v2-review';
import {
  CATALOG_V2_APPROVED_FIXED_TIERS, CATALOG_V2_INSPECTION_REFERENCES,
  CATALOG_V2_LOCK_ELECTRONIC_INSPECTION_REFERENCE_VND, CATALOG_V2_PRICE_POLICY,
  getCatalogV2ApprovedFixedTier, getCatalogV2InspectionReference,
} from '../../src/database/catalog-v2/catalog-v2-approved-price-tiers';

describe('Owner-approved labor S (staging only)', () => {
  it('binds exactly 28 fixed tiers to 17 existing services, never R or an inactive parent fixedPrice', () => {
    expect(CATALOG_V2_CATEGORIES).toHaveLength(13);
    expect(CATALOG_V2_SERVICES).toHaveLength(36);
    expect(CATALOG_V2_APPROVED_FIXED_TIERS).toHaveLength(28);
    const fixedCodes = new Set(CATALOG_V2_APPROVED_FIXED_TIERS.map(v => v.serviceCode));
    expect(fixedCodes.size).toBe(17);
    expect(CATALOG_V2_APPROVED_FIXED_TIERS.every(v => Number.isSafeInteger(v.laborPriceVnd) && v.laborPriceVnd > 0 && v.laborPriceVnd % 10000 === 9000)).toBe(true);
    expect(new Set(CATALOG_V2_APPROVED_FIXED_TIERS.map(v => v.variantCode)).size).toBe(28);
    expect(CATALOG_V2_APPROVED_FIXED_TIERS.every(v => CATALOG_V2_SERVICES.some(s => s.code === v.serviceCode && s.priceMode === 'FIXED_TIER_PENDING' && s.isActive === false))).toBe(true);
    expect(getCatalogV2ApprovedFixedTier('AC-02','AC-02-01')?.laborPriceVnd).toBe(199000);
    expect(getCatalogV2ApprovedFixedTier('WM-02','WM-02-08')?.laborPriceVnd).toBe(699000);
    expect(getCatalogV2ApprovedFixedTier('WM-02','NOT_VERIFIED')).toBeNull();
  });
  it('keeps 19 inspection services nonbinding; gated services do not become bookable', () => {
    expect(CATALOG_V2_INSPECTION_REFERENCES).toHaveLength(19);
    expect(new Set(CATALOG_V2_INSPECTION_REFERENCES.map(v => v.serviceCode)).size).toBe(19);
    expect(CATALOG_V2_INSPECTION_REFERENCES.every(v => CATALOG_V2_SERVICES.some(s => s.code === v.serviceCode && s.priceMode === 'INSPECTION_REQUIRED' && !s.isActive && s.fixedPrice === null))).toBe(true);
    expect(getCatalogV2InspectionReference('WM-01')?.suggestedLaborVnd).toBe(249000);
    expect(getCatalogV2InspectionReference('KT-05')?.activationGate).toBe('GATE');
    expect(getCatalogV2InspectionReference('KT-04')?.activationGate).toBe('LATER');
    expect(CATALOG_V2_LOCK_ELECTRONIC_INSPECTION_REFERENCE_VND).toBe(399000);
  });
  it('does not silently enable changes to user payment or DB', () => {
    expect(CATALOG_V2_PRICE_POLICY.ownerApprovedSAmounts).toBe(true);
    expect(CATALOG_V2_PRICE_POLICY.publicActivation).toBe(false);
    expect(CATALOG_V2_PRICE_POLICY.databaseMigrationExecuted).toBe(false);
    expect(CATALOG_V2_PRICE_POLICY.surveyFeeAutoChargeApproved).toBe(false);
    expect(CATALOG_V2_PRICE_POLICY.automaticPerPartLabor).toBe(false);
    expect(CATALOG_V2_PRICE_POLICY.platformLaborCommissionBps).toBe(1000);
    expect(CATALOG_V2_PRICE_POLICY.platformPartsCommissionBps).toBe(0);
    expect(CATALOG_V2_PRICE_POLICY.fixhomePartTechBonusRegularBps).toBe(300);
    expect(CATALOG_V2_PRICE_POLICY.fixhomePartTechBonusPromoBps).toBe(500);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CATALOG_V2_CATEGORIES, CATALOG_V2_OLD_CODE_CROSSWALK, CATALOG_V2_POLICY,
  CATALOG_V2_SERVICES, mapLegacyCodeForBooking,
} from '../../src/database/catalog-v2/catalog-v2-review';

describe('Catalog V2 staging contract (no shared DB writes)', () => {
  it('contains exactly 13 categories and 44 distinct general services (36 V2 + 8 V3)', () => {
    expect(CATALOG_V2_CATEGORIES).toHaveLength(13);
    expect(CATALOG_V2_SERVICES).toHaveLength(44);
    const categories = new Set(CATALOG_V2_CATEGORIES.map(([code]) => code));
    expect(categories.size).toBe(13);
    expect(new Set(CATALOG_V2_SERVICES.map(s => s.code)).size).toBe(44);
    expect(CATALOG_V2_SERVICES.every(s => categories.has(s.categoryCode as typeof CATALOG_V2_CATEGORIES[number][0]))).toBe(true);
  });

  it('stages rollout as 21 M1, 18 M2, 3 gated and 2 later', () => {
    for (const [phase, count] of [['M1', 21], ['M2', 18], ['GATE', 3], ['LATER', 2]] as const) {
      expect(CATALOG_V2_SERVICES.filter(s => s.phase === phase)).toHaveLength(count);
    }
  });

  it('never activates or invents a fixed price from an approved range', () => {
    expect(CATALOG_V2_POLICY.publicActivation).toBe(false);
    expect(CATALOG_V2_SERVICES.every(s => !s.isActive && s.fixedPrice === null)).toBe(true);
    expect(CATALOG_V2_SERVICES.every(s => Boolean(s.referencePriceText.trim()))).toBe(true);
  });

  it('covers every one of the 34 old codes without ambiguous auto-booking', () => {
    const codes = new Set(CATALOG_V2_SERVICES.map(s => s.code));
    expect(Object.keys(CATALOG_V2_OLD_CODE_CROSSWALK)).toHaveLength(34);
    expect(Object.values(CATALOG_V2_OLD_CODE_CROSSWALK).flat().every(s => codes.has(s))).toBe(true);
    expect(mapLegacyCodeForBooking('VE_SINH_DIEU_HOA')).toBeNull();
    expect(mapLegacyCodeForBooking('SUA_MAY_GIAT')).toBe('WM-01');
    expect(mapLegacyCodeForBooking('LAP_QUAT_DEN')).toBeNull();
    expect(mapLegacyCodeForBooking('DICH_VU_KHAC')).toBeNull();
    expect(mapLegacyCodeForBooking('SOME_UNKNOWN_CODE')).toBeNull();
  });

  it('keeps platform labor and technician parts bonus economically distinct', () => {
    expect(CATALOG_V2_POLICY.platformLaborCommissionBps).toBe(1000);
    expect(CATALOG_V2_POLICY.platformPartsCommissionBps).toBe(0);
    expect(CATALOG_V2_POLICY.fixHomePartTechnicianBonusBps).toBe(300);
    expect(CATALOG_V2_POLICY.fixHomePartTechnicianPromoBonusBps).toBe(500);
    expect(CATALOG_V2_POLICY.autoPerSkuReplacementLabor).toBe(false);
  });
});

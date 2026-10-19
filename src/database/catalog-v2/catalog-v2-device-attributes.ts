import { CATALOG_V2_APPROVED_FIXED_TIERS } from './catalog-v2-approved-price-tiers';
import { CATALOG_V2_OLD_CODE_CROSSWALK, CATALOG_V2_SERVICES } from './catalog-v2-review';

export type AcMounting = 'wall' | 'ceiling' | 'unknown';
export type AcHorsepower = 'up_to_1_5' | '2_to_2_5' | 'unknown';
export type WasherLoadingStyle = 'top' | 'front' | 'unknown';

/** Small, customer-reported facts only. Prices and catalog variants are server-owned. */
export interface CatalogV2DeviceAttributes {
  brand?: string;
  acMounting?: AcMounting;
  acHorsepower?: AcHorsepower;
  washerLoadingStyle?: WasherLoadingStyle;
  washerCapacityKg?: number;
}

export type BookingDeviceAttributesValidation =
  | { status: 'OMITTED'; snapshot: null }
  | { status: 'VALID'; snapshot: CatalogV2DeviceAttributes | null }
  | { status: 'INVALID_ATTRIBUTES' }
  | { status: 'SERVICE_MISMATCH' };

type DeviceFamily = 'air_conditioner' | 'washing_machine';

type LegacyFixedTierAttributes = {
  acMounting?: Exclude<AcMounting, 'unknown'>;
  acHorsepower?: Exclude<AcHorsepower, 'unknown'>;
  washerLoadingStyle?: Exclude<WasherLoadingStyle, 'unknown'>;
  washerCapacityKg?: { maxInclusive?: number; minExclusive?: number };
};

const LEGACY_FIXED_TIER_ATTRIBUTES: Readonly<Record<string, LegacyFixedTierAttributes>> = {
  VE_SINH_DIEU_HOA_1HP: { acMounting: 'wall', acHorsepower: 'up_to_1_5' },
  VE_SINH_DIEU_HOA_2HP: { acMounting: 'wall', acHorsepower: '2_to_2_5' },
  VE_SINH_DIEU_HOA_AM_TRAN: { acMounting: 'ceiling' },
  VE_SINH_MAY_GIAT_CUA_TREN_LE9: { washerLoadingStyle: 'top', washerCapacityKg: { maxInclusive: 9 } },
  VE_SINH_MAY_GIAT_CUA_TREN_GT9: { washerLoadingStyle: 'top', washerCapacityKg: { minExclusive: 9 } },
  VE_SINH_MAY_GIAT_CUA_NGANG_LE9: { washerLoadingStyle: 'front', washerCapacityKg: { maxInclusive: 9 } },
  VE_SINH_MAY_GIAT_CUA_NGANG_GT9: { washerLoadingStyle: 'front', washerCapacityKg: { minExclusive: 9 } },
};

/** Known facts may not contradict the legacy fixed-price service's defined scope. */
export function conflictsWithCatalogV2LegacyFixedTier(
  serviceCode: string,
  attributes: CatalogV2DeviceAttributes,
): boolean {
  const expected = LEGACY_FIXED_TIER_ATTRIBUTES[serviceCode];
  if (!expected) return false;

  const conflicts = (actual: string | undefined, value: string | undefined) =>
    value !== undefined && actual !== undefined && actual !== 'unknown' && actual !== value;
  if (conflicts(attributes.acMounting, expected.acMounting)
    || conflicts(attributes.acHorsepower, expected.acHorsepower)
    || conflicts(attributes.washerLoadingStyle, expected.washerLoadingStyle)) return true;

  const capacityRule = expected.washerCapacityKg;
  const capacity = attributes.washerCapacityKg;
  if (capacityRule?.maxInclusive !== undefined && capacity !== undefined && capacity > capacityRule.maxInclusive) {
    return true;
  }
  return capacityRule?.minExclusive !== undefined
    && capacity !== undefined
    && capacity <= capacityRule.minExclusive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getDeviceFamily(serviceCode: string): DeviceFamily | null {
  const directService = CATALOG_V2_SERVICES.find((service) => service.code === serviceCode);
  if (directService?.categoryCode === 'CAT_AC') return 'air_conditioner';
  if (directService && ['WM-01', 'WM-02', 'WM-03'].includes(directService.code)) return 'washing_machine';

  const targetCodes = CATALOG_V2_OLD_CODE_CROSSWALK[serviceCode];
  if (!targetCodes?.length) return null;
  const targets = targetCodes.map((code) => CATALOG_V2_SERVICES.find((service) => service.code === code));
  if (targets.every((service) => service?.categoryCode === 'CAT_AC')) return 'air_conditioner';
  if (targets.every((service) => service && ['WM-01', 'WM-02'].includes(service.code))) return 'washing_machine';
  return null;
}

export function validateCatalogV2DeviceAttributesForBooking(
  serviceCode: string,
  input: unknown,
): BookingDeviceAttributesValidation {
  if (input === undefined || input === null) return { status: 'OMITTED', snapshot: null };
  if (!isRecord(input)) return { status: 'INVALID_ATTRIBUTES' };

  const keys = Object.keys(input);
  const allowedKeys = new Set([
    'brand', 'acMounting', 'acHorsepower', 'washerLoadingStyle', 'washerCapacityKg',
  ]);
  if (keys.some((key) => !allowedKeys.has(key))) return { status: 'INVALID_ATTRIBUTES' };
  if (keys.length === 0) return { status: 'OMITTED', snapshot: null };

  const hasAcKeys = keys.some((key) => key === 'acMounting' || key === 'acHorsepower');
  const hasWasherKeys = keys.some((key) => key === 'washerLoadingStyle' || key === 'washerCapacityKg');
  const family = getDeviceFamily(serviceCode);
  if (!family || (hasAcKeys && family !== 'air_conditioner') || (hasWasherKeys && family !== 'washing_machine')) {
    return { status: 'SERVICE_MISMATCH' };
  }

  const snapshot: CatalogV2DeviceAttributes = {};
  const brand = input.brand;
  if (brand !== undefined && brand !== null) {
    if (typeof brand !== 'string' || brand.length > 64) return { status: 'INVALID_ATTRIBUTES' };
    const normalizedBrand = brand.trim();
    if (normalizedBrand) snapshot.brand = normalizedBrand;
  }

  const acMounting = input.acMounting;
  if (acMounting !== undefined && acMounting !== null) {
    if (typeof acMounting !== 'string' || !['wall', 'ceiling', 'unknown'].includes(acMounting)) {
      return { status: 'INVALID_ATTRIBUTES' };
    }
    snapshot.acMounting = acMounting as AcMounting;
  }

  const acHorsepower = input.acHorsepower;
  if (acHorsepower !== undefined && acHorsepower !== null) {
    if (typeof acHorsepower !== 'string' || !['up_to_1_5', '2_to_2_5', 'unknown'].includes(acHorsepower)) {
      return { status: 'INVALID_ATTRIBUTES' };
    }
    snapshot.acHorsepower = acHorsepower as AcHorsepower;
  }

  const washerLoadingStyle = input.washerLoadingStyle;
  if (washerLoadingStyle !== undefined && washerLoadingStyle !== null) {
    if (typeof washerLoadingStyle !== 'string' || !['top', 'front', 'unknown'].includes(washerLoadingStyle)) {
      return { status: 'INVALID_ATTRIBUTES' };
    }
    snapshot.washerLoadingStyle = washerLoadingStyle as WasherLoadingStyle;
  }

  const washerCapacityKg = input.washerCapacityKg;
  if (washerCapacityKg !== undefined && washerCapacityKg !== null) {
    if (
      typeof washerCapacityKg !== 'number' || !Number.isFinite(washerCapacityKg)
      || washerCapacityKg <= 0 || washerCapacityKg > 50
      || !Number.isInteger(washerCapacityKg * 10)
    ) return { status: 'INVALID_ATTRIBUTES' };
    snapshot.washerCapacityKg = washerCapacityKg;
  }

  return {
    status: 'VALID',
    snapshot: Object.keys(snapshot).length > 0 ? snapshot : null,
  };
}

export type CatalogV2VariantResolution =
  | { status: 'UNKNOWN_SERVICE'; serviceCode: string }
  | { status: 'INSPECTION_REQUIRED'; serviceCode: string }
  | { status: 'INVALID_ATTRIBUTES' | 'SERVICE_MISMATCH'; serviceCode: string }
  | { status: 'NO_APPROVED_VARIANTS'; serviceCode: string }
  | {
    status: 'MISSING_ATTRIBUTES' | 'AMBIGUOUS';
    serviceCode: string;
    missingAttributes: readonly string[];
    availableVariants: readonly { variantCode: string; conditionVi: string }[];
  }
  | { status: 'RESOLVED'; serviceCode: string; variantCode: string };

const MISSING_SCOPE_CONFIRMATION = 'service-specific-scope-confirmation';

export function deriveCatalogV2VariantResolution(
  serviceCode: string,
  deviceAttributes?: unknown,
): CatalogV2VariantResolution {
  const service = CATALOG_V2_SERVICES.find((item) => item.code === serviceCode);
  if (!service) return { status: 'UNKNOWN_SERVICE', serviceCode };
  const validation = validateCatalogV2DeviceAttributesForBooking(serviceCode, deviceAttributes);
  if (validation.status === 'INVALID_ATTRIBUTES' || validation.status === 'SERVICE_MISMATCH') {
    return { status: validation.status, serviceCode };
  }
  if (service.priceMode === 'INSPECTION_REQUIRED') return { status: 'INSPECTION_REQUIRED', serviceCode };
  const attributes = validation.status === 'VALID' ? validation.snapshot : null;
  const tiers = CATALOG_V2_APPROVED_FIXED_TIERS.filter((tier) => tier.serviceCode === serviceCode);
  const availableVariants = tiers.map(({ variantCode, conditionVi }) => ({ variantCode, conditionVi }));
  if (availableVariants.length === 0) return { status: 'NO_APPROVED_VARIANTS', serviceCode };

  if (serviceCode !== 'AC-02' && serviceCode !== 'WM-02') {
    return {
      status: 'MISSING_ATTRIBUTES',
      serviceCode,
      missingAttributes: [MISSING_SCOPE_CONFIRMATION],
      availableVariants,
    };
  }

  let candidateCodes: readonly string[];
  let missingAttributes: string[];
  let hasKnownCriterion: boolean;

  if (serviceCode === 'AC-02') {
    const mounting = attributes?.acMounting;
    const horsepower = attributes?.acHorsepower;
    const mountingKnown = mounting === 'wall' || mounting === 'ceiling';
    const horsepowerKnown = horsepower === 'up_to_1_5' || horsepower === '2_to_2_5';
    hasKnownCriterion = mountingKnown || horsepowerKnown;
    missingAttributes = [];
    if (!mountingKnown) missingAttributes.push('acMounting');
    if (mounting !== 'ceiling' && !horsepowerKnown) missingAttributes.push('acHorsepower');
    candidateCodes = tiers.filter((tier) => {
      if (mounting === 'wall' && tier.variantCode === 'AC-02-03') return false;
      if (mounting === 'ceiling' && tier.variantCode !== 'AC-02-03') return false;
      if (tier.variantCode === 'AC-02-01' && horsepower && horsepower !== 'unknown' && horsepower !== 'up_to_1_5') return false;
      if (tier.variantCode === 'AC-02-02' && horsepower && horsepower !== 'unknown' && horsepower !== '2_to_2_5') return false;
      return true;
    }).map((tier) => tier.variantCode);
  } else {
    const loadingStyle = attributes?.washerLoadingStyle;
    const capacity = attributes?.washerCapacityKg;
    const loadingKnown = loadingStyle === 'top' || loadingStyle === 'front';
    const capacityKnown = typeof capacity === 'number';
    hasKnownCriterion = loadingKnown || capacityKnown;
    missingAttributes = [];
    if (!loadingKnown) missingAttributes.push('washerLoadingStyle');
    if (!capacityKnown) missingAttributes.push('washerCapacityKg');
    candidateCodes = tiers.filter((tier) => {
      const isTop = tier.variantCode === 'WM-02-05' || tier.variantCode === 'WM-02-06';
      const isUnderOrEqualNine = tier.variantCode === 'WM-02-05' || tier.variantCode === 'WM-02-07';
      if (loadingKnown && ((loadingStyle === 'top') !== isTop)) return false;
      if (capacityKnown && ((capacity <= 9) !== isUnderOrEqualNine)) return false;
      return true;
    }).map((tier) => tier.variantCode);
  }

  const candidates = availableVariants.filter((variant) => candidateCodes.includes(variant.variantCode));
  if (candidates.length === 1 && missingAttributes.length === 0) {
    return { status: 'RESOLVED', serviceCode, variantCode: candidates[0].variantCode };
  }
  return {
    status: hasKnownCriterion ? 'AMBIGUOUS' : 'MISSING_ATTRIBUTES',
    serviceCode,
    missingAttributes,
    availableVariants: candidates,
  };
}

import { deriveCatalogV2VariantResolution } from './catalog-v2-device-attributes';
import {
  getCatalogV2ApprovedFixedTier,
  getCatalogV2InspectionReference,
} from './catalog-v2-approved-price-tiers';
import { CATALOG_V2_SERVICES } from './catalog-v2-review';

/**
 * Pure price-preview policy for the inactive V2 catalog.
 *
 * Only customer facts are accepted as input. A variant code and numeric price
 * are always derived from the owner-approved server catalog. All results stay
 * nonbinding until a separate activation and verification gate is approved.
 */
export type CatalogV2LaborPreview =
  | { status: 'UNKNOWN_SERVICE'; bookable: false; priceBinding: false }
  | {
    status: 'INSPECTION_REQUIRED';
    serviceCode: string;
    referenceLaborVnd: number | null;
    activationGate: 'M1' | 'M2' | 'GATE' | 'LATER';
    bookable: false;
    priceBinding: false;
  }
  | {
    status: 'VARIANT_REQUIRED' | 'AMBIGUOUS_VARIANT';
    serviceCode: string;
    missingAttributes: readonly string[];
    availableVariants: readonly { variantCode: string; conditionVi: string }[];
    bookable: false;
    priceBinding: false;
  }
  | {
    status: 'INVALID_DEVICE_ATTRIBUTES';
    serviceCode: string;
    bookable: false;
    priceBinding: false;
  }
  | {
    status: 'FIXED_TIER_PREVIEW';
    serviceCode: string;
    variantCode: string;
    laborPriceVnd: number;
    scopeVi: string;
    bookable: false;
    priceBinding: false;
  };

export function previewCatalogV2Labor(
  serviceCode: string,
  deviceAttributes?: unknown,
): CatalogV2LaborPreview {
  const service = CATALOG_V2_SERVICES.find((item) => item.code === serviceCode);
  if (!service) return { status: 'UNKNOWN_SERVICE', bookable: false, priceBinding: false };

  const resolution = deriveCatalogV2VariantResolution(serviceCode, deviceAttributes);
  if (resolution.status === 'INSPECTION_REQUIRED') {
    const reference = getCatalogV2InspectionReference(serviceCode);
    return {
      status: 'INSPECTION_REQUIRED',
      serviceCode,
      referenceLaborVnd: reference?.suggestedLaborVnd ?? null,
      activationGate: service.phase,
      bookable: false,
      priceBinding: false,
    };
  }

  if (resolution.status === 'INVALID_ATTRIBUTES' || resolution.status === 'SERVICE_MISMATCH') {
    return { status: 'INVALID_DEVICE_ATTRIBUTES', serviceCode, bookable: false, priceBinding: false };
  }

  if (resolution.status === 'MISSING_ATTRIBUTES' || resolution.status === 'NO_APPROVED_VARIANTS') {
    return {
      status: 'VARIANT_REQUIRED',
      serviceCode,
      missingAttributes: resolution.status === 'MISSING_ATTRIBUTES'
        ? resolution.missingAttributes
        : ['service-specific-scope-confirmation'],
      availableVariants: resolution.status === 'MISSING_ATTRIBUTES' ? resolution.availableVariants : [],
      bookable: false,
      priceBinding: false,
    };
  }

  if (resolution.status === 'AMBIGUOUS') {
    return {
      status: 'AMBIGUOUS_VARIANT',
      serviceCode,
      missingAttributes: resolution.missingAttributes,
      availableVariants: resolution.availableVariants,
      bookable: false,
      priceBinding: false,
    };
  }

  if (resolution.status !== 'RESOLVED') {
    return { status: 'UNKNOWN_SERVICE', bookable: false, priceBinding: false };
  }
  const tier = getCatalogV2ApprovedFixedTier(serviceCode, resolution.variantCode);
  if (!tier) {
    return {
      status: 'VARIANT_REQUIRED',
      serviceCode,
      missingAttributes: ['service-specific-scope-confirmation'],
      availableVariants: [],
      bookable: false,
      priceBinding: false,
    };
  }

  return {
    status: 'FIXED_TIER_PREVIEW',
    serviceCode,
    variantCode: tier.variantCode,
    laborPriceVnd: tier.laborPriceVnd,
    scopeVi: tier.conditionVi,
    bookable: false,
    priceBinding: false,
  };
}

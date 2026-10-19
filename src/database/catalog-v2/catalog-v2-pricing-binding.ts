import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CATALOG_V2_APPROVED_FIXED_TIERS } from './catalog-v2-approved-price-tiers';
import { deriveCatalogV2VariantResolution, validateCatalogV2DeviceAttributesForBooking } from './catalog-v2-device-attributes';
import { CATALOG_V2_SERVICES } from './catalog-v2-review';

export interface CatalogV2PricingInput {
  deviceAttributes?: unknown;
  selectedVariantCode?: string | null;
  /** Compatibility with the cross-team contract's initial field name. */
  variantCode?: string | null;
}

export interface CatalogV2PriceRow {
  id: string;
  service_id: string;
  variant_code: string;
  fixed_labor_price_vnd: string | number;
  included_scope: string;
  excluded_scope: string | null;
  is_active: boolean;
}

export interface CatalogV2PricingOption {
  variantId: string;
  variantCode: string;
  scopeVi: string;
  laborPriceVnd: number;
}

export interface CatalogV2PricingResult {
  serviceId: string;
  serviceCode: string;
  status: 'FIXED_PRICE' | 'INSPECTION_REQUIRED';
  bindingReady: boolean;
  /** GET is advisory. POST re-resolves under transaction locks before binding. */
  priceBinding: false;
  selectedVariant: CatalogV2PricingOption | null;
  possibleVariants: CatalogV2PricingOption[];
  missingAttributes: readonly string[];
  inspectionReason: 'MISSING_FACTS' | 'SCOPE_CONFIRMATION_REQUIRED' | 'NO_ACTIVE_APPROVED_TIER' | 'SERVICE_REQUIRES_INSPECTION' | null;
  priceRange: { minLaborVnd: number; maxLaborVnd: number; labelVi: 'Giá tham khảo'; priceBinding: false } | null;
  messageVi: string;
}

export type CatalogV2BookingPricingSnapshot = Omit<CatalogV2PricingResult, 'priceBinding'> & { priceBinding: boolean };

export function isCatalogV2Service(code: string): boolean {
  return CATALOG_V2_SERVICES.some(service => service.code === code);
}

export function catalogV2SelectedVariantCode(input: CatalogV2PricingInput): string | null {
  if (input.selectedVariantCode != null && input.variantCode != null && input.selectedVariantCode !== input.variantCode) {
    throw new BadRequestException('Lựa chọn phạm vi dịch vụ không thống nhất.');
  }
  const code = input.selectedVariantCode ?? input.variantCode ?? null;
  if (code !== null && (typeof code !== 'string' || !/^[A-Z]{2}-\d{2}-\d{2}$/.test(code))) {
    throw new BadRequestException('Lựa chọn phạm vi dịch vụ không hợp lệ.');
  }
  return code;
}

/** Both routes use the same approved catalog, fact validation and DB authority. */
export function resolveCatalogV2PricingFromRows(
  serviceId: string, serviceCode: string, input: CatalogV2PricingInput, rows: readonly CatalogV2PriceRow[],
): CatalogV2PricingResult {
  const service = CATALOG_V2_SERVICES.find(s => s.code === serviceCode);
  if (!service || !['M1', 'M2'].includes(service.phase)) throw new NotFoundException('Dịch vụ chưa mở.');
  const selectedCode = catalogV2SelectedVariantCode(input);
  const validated = validateCatalogV2DeviceAttributesForBooking(serviceCode, input.deviceAttributes);
  if (validated.status === 'INVALID_ATTRIBUTES' || validated.status === 'SERVICE_MISMATCH') {
    throw new BadRequestException('Thông tin thiết bị không phù hợp với dịch vụ đã chọn.');
  }
  if (selectedCode === 'AC-03-04' && validated.status === 'VALID' && validated.snapshot?.acMounting === 'ceiling') {
    throw new BadRequestException('Phạm vi lắp điều hòa treo tường không phù hợp với thiết bị âm trần.');
  }
  const resolution = deriveCatalogV2VariantResolution(serviceCode, input.deviceAttributes);
  const approved = CATALOG_V2_APPROVED_FIXED_TIERS.filter(t => t.serviceCode === serviceCode);
  const options = approved.flatMap(t => {
    const matches = rows.filter(r => r.service_id === serviceId && r.variant_code === t.variantCode);
    const row = matches[0];
    if (matches.length !== 1 || !row.is_active || Number(row.fixed_labor_price_vnd) !== t.laborPriceVnd
      || row.included_scope !== t.conditionVi || row.excluded_scope !== null) return [];
    return [{ variantId: row.id, variantCode: t.variantCode, scopeVi: row.included_scope, laborPriceVnd: Number(row.fixed_labor_price_vnd) }];
  });
  const candidateCodes = resolution.status === 'RESOLVED' ? [resolution.variantCode]
    : 'availableVariants' in resolution ? resolution.availableVariants.map(v => v.variantCode) : [];
  const possibleVariants = options.filter(o => candidateCodes.includes(o.variantCode));
  if (selectedCode && (!options.some(o => o.variantCode === selectedCode) || !candidateCodes.includes(selectedCode))) {
    throw new BadRequestException('Phạm vi đã chọn không còn áp dụng hoặc không phù hợp với thiết bị.');
  }

  const automatic = serviceCode === 'AC-02' || serviceCode === 'WM-02';
  const resolvedCode = automatic ? resolution.status === 'RESOLVED' ? resolution.variantCode : null : selectedCode;
  const needsCassetteScope = resolvedCode === 'AC-02-03' && selectedCode !== 'AC-02-03';
  const selectedVariant = !needsCassetteScope && resolvedCode
    ? possibleVariants.find(o => o.variantCode === resolvedCode) ?? null : null;
  const missingAttributes = selectedVariant ? [] : 'missingAttributes' in resolution ? resolution.missingAttributes
    : needsCassetteScope ? ['service-specific-scope-confirmation'] : [];
  const prices = possibleVariants.map(o => o.laborPriceVnd);
  const priceRange = !selectedVariant && prices.length > 1 && Math.min(...prices) < Math.max(...prices)
    ? { minLaborVnd: Math.min(...prices), maxLaborVnd: Math.max(...prices), labelVi: 'Giá tham khảo' as const, priceBinding: false as const } : null;
  return {
    serviceId, serviceCode, status: selectedVariant ? 'FIXED_PRICE' : 'INSPECTION_REQUIRED',
    bindingReady: selectedVariant !== null, priceBinding: false, selectedVariant, possibleVariants,
    missingAttributes,
    inspectionReason: selectedVariant ? null : approved.length === 0 ? 'SERVICE_REQUIRES_INSPECTION'
      : possibleVariants.length === 0 ? 'NO_ACTIVE_APPROVED_TIER'
        : !automatic || needsCassetteScope ? 'SCOPE_CONFIRMATION_REQUIRED' : 'MISSING_FACTS',
    priceRange, messageVi: selectedVariant ? 'Tiền công theo phạm vi đã chọn, chưa gồm linh kiện và vật tư'
      : priceRange ? 'Giá tham khảo. Kỹ thuật viên khảo sát và gửi báo giá để bạn duyệt.' : 'Cần khảo sát để báo giá',
  };
}

export async function resolveCatalogV2Pricing(
  manager: Pick<EntityManager, 'query'>, serviceId: string, input: CatalogV2PricingInput, lock = false,
): Promise<CatalogV2PricingResult> {
  const services: { code: string }[] = await manager.query(`
    SELECT s.code FROM services s JOIN service_categories c ON c.id = s.category_id
    WHERE s.id = $1 AND s.is_active = true AND c.is_active = true
    ${lock ? 'FOR SHARE OF s, c' : ''}
  `, [serviceId]);
  if (services.length !== 1) throw new NotFoundException('Dịch vụ chưa mở.');
  const rows: CatalogV2PriceRow[] = await manager.query(`
    SELECT id, service_id, variant_code, fixed_labor_price_vnd, included_scope, excluded_scope, is_active
    FROM service_price_variants WHERE service_id = $1 ORDER BY variant_code
    ${lock ? 'FOR SHARE' : ''}
  `, [serviceId]);
  return resolveCatalogV2PricingFromRows(serviceId, services[0].code, input, rows);
}

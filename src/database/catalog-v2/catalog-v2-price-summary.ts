import type { EntityManager } from 'typeorm';
import { CATALOG_V2_APPROVED_FIXED_TIERS, CATALOG_V2_INSPECTION_REFERENCES } from './catalog-v2-approved-price-tiers';
import type { CatalogV2PriceRow } from './catalog-v2-pricing-binding';
import { CATALOG_V2_SERVICES } from './catalog-v2-review';

export interface CatalogV2PriceSummary {
  kind: 'fixed_range' | 'inspection_reference' | 'inspection_only';
  minLaborVnd: number | null;
  maxLaborVnd: number | null;
  /** Nonbinding estimate only; never a minimum or a booking price. */
  suggestedLaborVnd?: number;
}

/** Enrich public reads only. One batch for the response, never the parent fixedPrice. */
export async function addCatalogV2PriceSummaries<T extends { id: string; code: string; isActive: boolean }>(
  manager: Pick<EntityManager, 'query'>, services: T[],
): Promise<(T & { priceSummary?: CatalogV2PriceSummary })[]> {
  const eligible = services.filter(s => s.isActive && CATALOG_V2_SERVICES.some(
    draft => draft.code === s.code && (draft.phase === 'M1' || draft.phase === 'M2'),
  ));
  if (!eligible.length) return services;
  const rows: CatalogV2PriceRow[] = await manager.query(`
    SELECT service_id, variant_code, fixed_labor_price_vnd, included_scope, excluded_scope, is_active
    FROM service_price_variants WHERE service_id = ANY($1::uuid[]) AND is_active = true
  `, [[...new Set(eligible.map(s => s.id))]]);
  const byService = new Map<string, CatalogV2PriceRow[]>();
  for (const row of rows) {
    if (!row.is_active) continue;
    const group = byService.get(row.service_id) ?? [];
    group.push(row);
    byService.set(row.service_id, group);
  }
  for (const service of eligible) {
    const active = byService.get(service.id) ?? [];
    const approved = CATALOG_V2_APPROVED_FIXED_TIERS.filter(t => t.serviceCode === service.code);
    const seen = new Set<string>();
    const consistent = active.every(row => {
      const tier = approved.find(t => t.variantCode === row.variant_code);
      if (!tier || seen.has(row.variant_code) || Number(row.fixed_labor_price_vnd) !== tier.laborPriceVnd
        || row.included_scope !== tier.conditionVi || row.excluded_scope !== null) return false;
      seen.add(row.variant_code);
      return true;
    });
    let priceSummary: CatalogV2PriceSummary = { kind: 'inspection_only', minLaborVnd: null, maxLaborVnd: null };
    if (consistent && active.length) {
      const prices = active.map(row => Number(row.fixed_labor_price_vnd));
      priceSummary = { kind: 'fixed_range', minLaborVnd: Math.min(...prices), maxLaborVnd: Math.max(...prices) };
    } else if (consistent && !approved.length) {
      const reference = CATALOG_V2_INSPECTION_REFERENCES.find(r => r.serviceCode === service.code && r.activationGate === 'M1_M2');
      if (reference) priceSummary = { ...priceSummary, kind: 'inspection_reference', suggestedLaborVnd: reference.suggestedLaborVnd };
    }
    Object.assign(service, { priceSummary });
  }
  return services;
}

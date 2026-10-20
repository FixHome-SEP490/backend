import type { DataSource, EntityManager } from 'typeorm';
import { CATALOG_V2_CATEGORIES, CATALOG_V2_SERVICES, CATALOG_V2_OLD_CODE_CROSSWALK } from './catalog-v2-review';
import { CATALOG_V2_APPROVED_FIXED_TIERS } from './catalog-v2-approved-price-tiers';

/**
 * Opt-in INACTIVE catalog staging only.
 * - No CLI entry point and not imported by production seed/runtime.
 * - Run only after schema migration rehearsal on an isolated PostgreSQL clone.
 * - New codes only; never deactivate, replace or delete the 34 legacy services.
 * - Never mutate old quotation IDs or the FixHome parts catalog.
 * - A rerun is idempotent: it inserts missing rows but refuses an existing
 *   active record or a mismatched price. It never silently overwrites edits.
 *
 * Inactive staging service pricing_mode is INSPECTION_REQUIRED; fixed-price
 * mode may only be activated later with validated attributes + exact variant.
 */
export interface CatalogV2StageCounts {
  categories: number;
  services: number;
  priceVariants: number;
  aliases: number;
}

type QueryFn = Pick<EntityManager, 'query'>;

async function requireInactive(
  db: QueryFn, table: 'service_categories' | 'services', code: string,
): Promise<string> {
  const rows = await db.query(
    `SELECT "id", "is_active" FROM "${table}" WHERE "code" = $1`, [code],
  ) as Array<{ id: string; is_active: boolean }>;
  if (rows.length !== 1 || rows[0].is_active) {
    throw new Error(`Catalog V2 staging conflict: ${table} ${code} missing or active`);
  }
  return rows[0].id;
}

export async function stageCatalogV2Inactive(dataSource: DataSource): Promise<CatalogV2StageCounts> {
  return dataSource.transaction(async (db) => {
    const ids = new Map<string, string>();
    for (const [i, [code, name]] of CATALOG_V2_CATEGORIES.entries()) {
      await db.query(`
        INSERT INTO "service_categories"
          ("code", "name", "slug", "sort_order", "description", "is_active")
        VALUES ($1, $2, $3, $4, $5, false)
        ON CONFLICT ("code") DO NOTHING
      `, [code, name, code.toLowerCase().replaceAll('_', '-'), i + 1, 'Catalog V2 — chưa kích hoạt']);
      ids.set(code, await requireInactive(db, 'service_categories', code));
    }

    for (const s of CATALOG_V2_SERVICES) {
      const categoryId = ids.get(s.categoryCode);
      if (!categoryId) throw new Error(`Unknown category ${s.categoryCode}`);
      await db.query(`
        INSERT INTO "services"
          ("code", "category_id", "name", "slug", "description",
           "base_price", "min_price", "max_price", "fixed_price",
           "scope_description", "pricing_mode", "unit",
           "estimated_minutes", "is_active")
        VALUES ($1,$2,$3,$4,$5,0,0,0,NULL,$6,'inspection_required','Lần',60,false)
        ON CONFLICT ("code") DO NOTHING
      `, [
        s.code, categoryId, s.name, s.code.toLowerCase(),
        'Giá tùy thuộc thuộc tính thiết bị hoặc khảo sát.',
        'Tiền công tiêu chuẩn chưa gồm linh kiện, vật tư và công phát sinh ngoài phạm vi.',
      ]);
      ids.set(s.code, await requireInactive(db, 'services', s.code));
    }

    for (const tier of CATALOG_V2_APPROVED_FIXED_TIERS) {
      const serviceId = ids.get(tier.serviceCode);
      if (!serviceId) throw new Error(`Missing service ${tier.serviceCode}`);
      await db.query(`
        INSERT INTO "service_price_variants"
          ("service_id", "variant_code", "device_attributes",
           "fixed_labor_price_vnd", "included_scope", "is_active")
        VALUES ($1,$2,$3::jsonb,$4,$5,false)
        ON CONFLICT ("service_id", "variant_code") DO NOTHING
      `, [
        serviceId, tier.variantCode,
        JSON.stringify({ reviewVariantCode: tier.variantCode, schemaStatus: 'UNMAPPED_PENDING_QUESTIONNAIRE' }),
        tier.laborPriceVnd, tier.conditionVi,
      ]);
      const rows = await db.query(`
        SELECT "fixed_labor_price_vnd", "is_active"
        FROM "service_price_variants"
        WHERE "service_id" = $1 AND "variant_code" = $2
      `, [serviceId, tier.variantCode]) as Array<{ fixed_labor_price_vnd: string | number; is_active: boolean }>;
      if (rows.length !== 1 || rows[0].is_active || Number(rows[0].fixed_labor_price_vnd) !== tier.laborPriceVnd) {
        throw new Error(`Catalog V2 staging price drift at ${tier.variantCode}`);
      }
    }

    for (const [oldCode, targets] of Object.entries(CATALOG_V2_OLD_CODE_CROSSWALK)) {
      const resolution = targets.length === 1 ? 'AUTO' : targets.length === 0 && oldCode !== 'DICH_VU_KHAC' && oldCode !== 'KIEM_TRA_CHAN_DOAN_THIET_BI' ? 'RETIRED' : 'CLARIFY';
      const targetId = resolution === 'AUTO' ? ids.get(targets[0]) : null;
      if (resolution === 'AUTO' && !targetId) throw new Error(`Invalid alias target for ${oldCode}`);
      await db.query(`
        INSERT INTO "service_code_aliases_v2"
          ("legacy_service_code", "target_service_id", "resolution", "notes", "is_active")
        VALUES ($1,$2,$3,$4,false)
        ON CONFLICT ("legacy_service_code") DO NOTHING
      `, [oldCode, targetId ?? null, resolution, 'Historical code: mapping inactive until controlled cutover']);
      const rows = await db.query(`
        SELECT "resolution", "target_service_id", "is_active"
        FROM "service_code_aliases_v2" WHERE "legacy_service_code" = $1
      `, [oldCode]) as Array<{ resolution: string; target_service_id: string | null; is_active: boolean }>;
      if (rows.length !== 1 || rows[0].is_active || rows[0].resolution !== resolution
        || (rows[0].target_service_id ?? null) !== (targetId ?? null)) {
        throw new Error(`Catalog V2 staging alias drift: ${oldCode}`);
      }
    }

    return {
      categories: CATALOG_V2_CATEGORIES.length,
      services: CATALOG_V2_SERVICES.length,
      priceVariants: CATALOG_V2_APPROVED_FIXED_TIERS.length,
      aliases: Object.keys(CATALOG_V2_OLD_CODE_CROSSWALK).length,
    };
  });
}

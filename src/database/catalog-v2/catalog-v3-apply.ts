import type { DataSource, EntityManager } from 'typeorm';
import { CATALOG_V2_APPROVED_FIXED_TIERS } from './catalog-v2-approved-price-tiers';
import { CATALOG_V2_SERVICES } from './catalog-v2-review';
import * as partsData from '../seeds/data/parts-catalog-791.json';

/**
 * Catalog V3 (PO 19–20/10/2026): chỉ BỔ SUNG vào catalog V2 đang chạy.
 * - Thêm dịch vụ V3 còn thiếu vào danh mục V2 đã có; dịch vụ M1/M2 bật, LATER/GATE tắt.
 * - Thêm biến thể giá đã duyệt còn thiếu cho dịch vụ đang có trong DB; bật theo dịch vụ.
 * - Thêm linh kiện V3 còn thiếu và cập nhật giá 11 linh kiện đã rà theo thị trường.
 * - Không xoá, không tắt, không đổi giá biến thể đã có. Biến thể lệch giá/phạm vi thì dừng.
 * Chạy lại an toàn: lần hai không đổi gì.
 */
export const CATALOG_V3_SERVICE_CODES = ['WM-06', 'FR-02', 'WH-03', 'KT-06', 'KT-07', 'KT-08', 'KT-09', 'KT-10'] as const;
export const CATALOG_V3_PART_PRICE_FIX_SKUS = [
  'HA001', 'HA007', 'HA012', 'HA015', 'HA036', 'HA037', 'HA038', 'HA043', 'HA049', 'HA056', 'HA060',
] as const;
const V3_PART_PREFIXES = ['DWS', 'DRY', 'LCK'];
const V3_PART_EXTRA_SKUS = ['HA066', 'HA067'];

interface PartItem { sku: string; name: string; description: string; sellingPrice: number; warrantyDays: number; warrantyPolicy: string }

export interface CatalogV3ApplyResult {
  servicesInserted: string[];
  variantsInserted: string[];
  partsInserted: string[];
  partPricesUpdated: string[];
}

type QueryFn = Pick<EntityManager, 'query'>;

function partItems(): PartItem[] {
  const raw = partsData as unknown as PartItem[] | { default: PartItem[] };
  return Array.isArray(raw) ? raw : raw.default;
}

export function catalogV3PartItems(): { newParts: PartItem[]; priceFixes: PartItem[] } {
  const all = partItems();
  const isNew = (sku: string) => V3_PART_PREFIXES.some(p => sku.startsWith(p)) || V3_PART_EXTRA_SKUS.includes(sku);
  return {
    newParts: all.filter(p => isNew(p.sku)),
    priceFixes: all.filter(p => (CATALOG_V3_PART_PRICE_FIX_SKUS as readonly string[]).includes(p.sku)),
  };
}

export async function applyCatalogV3(db: QueryFn): Promise<CatalogV3ApplyResult> {
  const result: CatalogV3ApplyResult = { servicesInserted: [], variantsInserted: [], partsInserted: [], partPricesUpdated: [] };

  for (const code of CATALOG_V3_SERVICE_CODES) {
    const draft = CATALOG_V2_SERVICES.find(s => s.code === code);
    if (!draft) throw new Error(`Catalog V3: thiếu định nghĩa ${code}`);
    const categories = await db.query('SELECT "id" FROM "service_categories" WHERE "code" = $1', [draft.categoryCode]) as { id: string }[];
    if (categories.length !== 1) throw new Error(`Catalog V3: thiếu danh mục ${draft.categoryCode} cho ${code}`);
    const active = draft.phase === 'M1' || draft.phase === 'M2';
    const inserted = await db.query(`
      INSERT INTO "services"
        ("code", "category_id", "name", "slug", "description",
         "base_price", "min_price", "max_price", "fixed_price",
         "scope_description", "pricing_mode", "unit", "estimated_minutes", "is_active")
      VALUES ($1,$2,$3,$4,$5,0,0,0,NULL,$6,'inspection_required','Lần',60,$7)
      ON CONFLICT ("code") DO NOTHING
      RETURNING "id"
    `, [
      code, categories[0].id, draft.name, code.toLowerCase(),
      'Catalog V3 — giá tùy thuộc thuộc tính thiết bị hoặc khảo sát.',
      'Tiền công tiêu chuẩn chưa gồm linh kiện, vật tư và công phát sinh ngoài phạm vi.',
      active,
    ]) as { id: string }[];
    if (inserted.length) result.servicesInserted.push(code);
  }

  const services = await db.query('SELECT "id", "code", "is_active" FROM "services"') as { id: string; code: string; is_active: boolean }[];
  const byCode = new Map(services.map(s => [s.code, s]));
  for (const tier of CATALOG_V2_APPROVED_FIXED_TIERS) {
    const service = byCode.get(tier.serviceCode);
    if (!service) continue; // dịch vụ đã xoá khỏi DB (ví dụ máy bơm)
    const rows = await db.query(`
      SELECT "fixed_labor_price_vnd", "included_scope", "excluded_scope"
      FROM "service_price_variants" WHERE "service_id" = $1 AND "variant_code" = $2
    `, [service.id, tier.variantCode]) as { fixed_labor_price_vnd: string | number; included_scope: string; excluded_scope: string | null }[];
    if (rows.length) {
      const row = rows[0];
      if (Number(row.fixed_labor_price_vnd) !== tier.laborPriceVnd || row.included_scope !== tier.conditionVi || row.excluded_scope !== null) {
        throw new Error(`Catalog V3: biến thể ${tier.variantCode} trong DB lệch với bảng giá đã duyệt`);
      }
      continue;
    }
    await db.query(`
      INSERT INTO "service_price_variants"
        ("service_id", "variant_code", "device_attributes", "fixed_labor_price_vnd", "included_scope", "is_active")
      VALUES ($1,$2,$3::jsonb,$4,$5,$6)
    `, [
      service.id, tier.variantCode,
      JSON.stringify({ reviewVariantCode: tier.variantCode, schemaStatus: 'UNMAPPED_PENDING_QUESTIONNAIRE' }),
      tier.laborPriceVnd, tier.conditionVi, service.is_active,
    ]);
    result.variantsInserted.push(tier.variantCode);
  }

  const { newParts, priceFixes } = catalogV3PartItems();
  for (const part of newParts) {
    const inserted = await db.query(`
      INSERT INTO "fixhome_parts" ("sku", "name", "description", "selling_price", "warranty_days", "warranty_policy", "is_active")
      SELECT $1::varchar, $2::varchar, $3::text, $4::numeric, $5::int, $6::text, true
      WHERE NOT EXISTS (SELECT 1 FROM "fixhome_parts" WHERE "sku" = $1::varchar)
      RETURNING "id"
    `, [part.sku, part.name, part.description, part.sellingPrice, part.warrantyDays, part.warrantyPolicy]) as { id: string }[];
    if (inserted.length) result.partsInserted.push(part.sku);
  }
  for (const part of priceFixes) {
    const updated = await db.query(`
      UPDATE "fixhome_parts" SET "selling_price" = $2::numeric, "description" = $3::text, "updated_at" = now()
      WHERE "sku" = $1 AND ("selling_price" <> $2::numeric OR "description" IS DISTINCT FROM $3::text)
      RETURNING "id"
    `, [part.sku, part.sellingPrice, part.description]) as { id: string }[];
    if (updated.length) result.partPricesUpdated.push(part.sku);
  }
  return result;
}

export async function applyCatalogV3InTransaction(dataSource: DataSource): Promise<CatalogV3ApplyResult> {
  return dataSource.transaction(manager => applyCatalogV3(manager));
}

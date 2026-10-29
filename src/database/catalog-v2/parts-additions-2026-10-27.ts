import type { EntityManager } from 'typeorm';
import * as partsData from '../seeds/data/parts-catalog-2026-10-27.json';

/**
 * Linh kiện bổ sung 27/10/2026 (PO): chỉ THÊM vào `fixhome_parts`, không sửa, không tắt mã nào đã có.
 * - 36 mã điện và đèn (ổ cắm, công tắc, aptomat, bóng, driver LED...) có trong bảng V3 nhưng chưa bán.
 *   Giá bán = giá thấp nhất của khoảng V3, như 835 mã đang bán.
 * - Linh kiện, vật tư phổ biến cho dịch vụ đang mở mà chưa có: nạp gas máy lạnh và tủ lạnh (vật tư,
 *   không phải dịch vụ riêng, theo quyết định 19/10), thanh magie bình nóng lạnh, motor và than hoạt tính
 *   máy hút mùi, giá treo tivi, dây và bát sen. Giá theo thị trường 10/2026 (PO ủy quyền 19/10), nguồn
 *   ghi trong `description` của từng mã.
 * Chạy lại an toàn: lần hai không đổi gì.
 */
export interface PartAddition {
  sku: string;
  name: string;
  description: string;
  sellingPrice: number;
  warrantyDays: number;
  warrantyPolicy: string;
}

type QueryFn = Pick<EntityManager, 'query'>;

export function partsAdditions20261027(): PartAddition[] {
  const raw = partsData as unknown as PartAddition[] | { default: PartAddition[] };
  return Array.isArray(raw) ? raw : raw.default;
}

export async function applyPartsAdditions20261027(db: QueryFn): Promise<{ inserted: string[]; skipped: string[] }> {
  const result = { inserted: [] as string[], skipped: [] as string[] };
  for (const part of partsAdditions20261027()) {
    const rows = await db.query(`
      INSERT INTO "fixhome_parts" ("sku", "name", "description", "selling_price", "warranty_days", "warranty_policy", "is_active")
      SELECT $1::varchar, $2::varchar, $3::text, $4::numeric, $5::int, $6::text, true
      WHERE NOT EXISTS (SELECT 1 FROM "fixhome_parts" WHERE "sku" = $1::varchar)
      RETURNING "id"
    `, [part.sku, part.name, part.description, part.sellingPrice, part.warrantyDays, part.warrantyPolicy]) as { id: string }[];
    (rows.length ? result.inserted : result.skipped).push(part.sku);
  }
  return result;
}

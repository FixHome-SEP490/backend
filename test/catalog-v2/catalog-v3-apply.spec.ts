import { describe, expect, it, vi } from 'vitest';
import { applyCatalogV3, catalogV3PartItems, CATALOG_V3_SERVICE_CODES } from '../../src/database/catalog-v2/catalog-v3-apply';
import { CATALOG_V2_APPROVED_FIXED_TIERS } from '../../src/database/catalog-v2/catalog-v2-approved-price-tiers';

/** DB giả mô phỏng catalog V2 đang chạy sau khi đã xoá máy bơm (PU-01, PU-02). */
function fakeDatabase() {
  const categories = new Map(['CAT_AC', 'CAT_LAUNDRY', 'CAT_FRIDGE', 'CAT_HEATER', 'CAT_KITCHEN', 'CAT_SANITARY', 'CAT_TV']
    .map((code, i) => [code, `cat-${i}`]));
  const services = new Map<string, { id: string; code: string; is_active: boolean; category_id: string }>();
  for (const code of ['AC-02', 'WM-02', 'SA-03', 'TV-01', 'KT-02']) services.set(code, { id: `svc-${code}`, code, is_active: true, category_id: 'x' });
  const variants = new Map<string, { fixed_labor_price_vnd: number; included_scope: string; excluded_scope: string | null; is_active: boolean }>();
  for (const t of CATALOG_V2_APPROVED_FIXED_TIERS.slice(0, 28)) {
    if (!services.has(t.serviceCode)) continue;
    variants.set(`svc-${t.serviceCode}:${t.variantCode}`, { fixed_labor_price_vnd: t.laborPriceVnd, included_scope: t.conditionVi, excluded_scope: null, is_active: true });
  }
  const parts = new Map<string, { selling_price: number; description: string }>([['HA001', { selling_price: 120000, description: 'cũ' }]]);
  const sql: string[] = [];
  const query = vi.fn(async (statement: string, params: unknown[] = []) => {
    sql.push(statement.toLowerCase());
    const p = params as Array<string | number | boolean | null>;
    if (statement.includes('FROM "service_categories"')) {
      return categories.has(String(p[0])) ? [{ id: categories.get(String(p[0])) }] : [];
    }
    if (statement.includes('INSERT INTO "services"')) {
      if (services.has(String(p[0]))) return [];
      services.set(String(p[0]), { id: `svc-${p[0]}`, code: String(p[0]), is_active: Boolean(p[6]), category_id: String(p[1]) });
      return [{ id: `svc-${p[0]}` }];
    }
    if (statement.includes('SELECT "id", "code", "is_active" FROM "services"')) return [...services.values()];
    if (statement.includes('FROM "service_price_variants"')) {
      const row = variants.get(`${p[0]}:${p[1]}`);
      return row ? [row] : [];
    }
    if (statement.includes('INSERT INTO "service_price_variants"')) {
      variants.set(`${p[0]}:${p[1]}`, { fixed_labor_price_vnd: Number(p[3]), included_scope: String(p[4]), excluded_scope: null, is_active: Boolean(p[5]) });
      return [];
    }
    if (statement.includes('INSERT INTO "fixhome_parts"')) {
      if (parts.has(String(p[0]))) return [];
      parts.set(String(p[0]), { selling_price: Number(p[3]), description: String(p[2]) });
      return [{ id: String(p[0]) }];
    }
    if (statement.includes('SELECT "selling_price", "description" FROM "fixhome_parts"')) {
      const row = parts.get(String(p[0]));
      return row ? [{ selling_price: row.selling_price.toFixed(2), description: row.description }] : [];
    }
    if (statement.includes('UPDATE "fixhome_parts"')) {
      const row = parts.get(String(p[0]));
      const changed = Boolean(row) && !(row!.selling_price === Number(p[1]) && row!.description === p[2]);
      if (changed) parts.set(String(p[0]), { selling_price: Number(p[1]), description: String(p[2]) });
      // Như TypeORM với Postgres: UPDATE trả [rows, rowCount], mảng luôn có 2 phần tử.
      return [[], changed ? 1 : 0];
    }
    return [];
  });
  return { db: { query } as never, query, services, variants, parts, sql };
}

describe('Catalog V3 additions onto the running V2 catalog', () => {
  it('adds the 8 V3 services under existing categories; LATER stays off; no V2 row is touched', async () => {
    const f = fakeDatabase();
    const result = await applyCatalogV3(f.db);
    expect(result.servicesInserted).toEqual([...CATALOG_V3_SERVICE_CODES]);
    expect(f.services.get('FR-02')).toMatchObject({ is_active: true });
    expect(f.services.get('KT-07')).toMatchObject({ is_active: true });
    expect(f.services.get('KT-10')).toMatchObject({ is_active: false });
    expect(result.variantsInserted).toContain('AC-02-31');
    expect(result.variantsInserted).toContain('WM-02-34');
    expect(result.variantsInserted).not.toContain('PU-02-21');
    expect(result.variantsInserted).not.toContain('AC-02-01');
    expect(f.variants.get('svc-KT-10:KT-10-55')).toMatchObject({ is_active: false, fixed_labor_price_vnd: 449000 });
    expect(f.variants.get('svc-FR-02:FR-02-44')).toMatchObject({ is_active: true, fixed_labor_price_vnd: 349000 });
    const sql = f.sql.join('\n');
    expect(sql).not.toMatch(/delete from|truncate |drop table|update "services"|update "service_price_variants"|is_active" = false/);
  });

  it('adds 44 V3 parts and fixes 11 market prices, then a rerun changes nothing', async () => {
    const f = fakeDatabase();
    const { newParts, priceFixes } = catalogV3PartItems();
    expect(newParts).toHaveLength(44);
    expect(priceFixes).toHaveLength(11);
    expect(priceFixes.find(p => p.sku === 'HA036')?.sellingPrice).toBe(10000);
    const first = await applyCatalogV3(f.db);
    expect(first.partsInserted).toHaveLength(44);
    expect(first.partPricesUpdated).toEqual(['HA001']);
    expect(f.parts.get('HA001')?.selling_price).toBe(15000);
    const second = await applyCatalogV3(f.db);
    expect(second).toEqual({ servicesInserted: [], variantsInserted: [], partsInserted: [], partPricesUpdated: [] });
  });

  it('refuses a variant whose DB price or scope drifted from the approved table', async () => {
    const f = fakeDatabase();
    f.variants.get('svc-AC-02:AC-02-01')!.fixed_labor_price_vnd = 1;
    await expect(applyCatalogV3(f.db)).rejects.toThrow(/AC-02-01/);
  });

  it('refuses when a V3 category is missing instead of inventing one', async () => {
    const f = fakeDatabase();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (statement: string, params?: unknown[]) =>
      statement.includes('FROM "service_categories"') && params?.[0] === 'CAT_FRIDGE' ? [] : original(statement, params));
    await expect(applyCatalogV3(f.db)).rejects.toThrow(/CAT_FRIDGE/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { stageCatalogV2Inactive } from '../../src/database/catalog-v2/catalog-v2-stage-inactive';

function fakeDatabase() {
  const categories = new Map<string, { id: string; is_active: boolean }>();
  const services = new Map<string, { id: string; is_active: boolean }>();
  const variants = new Map<string, { fixed_labor_price_vnd: number; is_active: boolean }>();
  const aliases = new Map<string, { resolution: string; target_service_id: string | null; is_active: boolean }>();
  const sql: string[] = [];
  let counter = 0;
  const query = vi.fn(async (statement: string, params: unknown[] = []) => {
    sql.push(statement.toLowerCase());
    const p = params as Array<string | number | null>;
    if (statement.includes('INSERT INTO "service_categories"')) {
      if (!categories.has(String(p[0]))) categories.set(String(p[0]), { id: 'category-' + (++counter), is_active: false });
    } else if (statement.includes('INSERT INTO "services"')) {
      if (!services.has(String(p[0]))) services.set(String(p[0]), { id: 'service-' + (++counter), is_active: false });
    } else if (statement.includes('INSERT INTO "service_price_variants"')) {
      const key = String(p[0]) + ':' + String(p[1]);
      if (!variants.has(key)) variants.set(key, { fixed_labor_price_vnd: Number(p[3]), is_active: false });
    } else if (statement.includes('INSERT INTO "service_code_aliases_v2"')) {
      if (!aliases.has(String(p[0]))) aliases.set(String(p[0]), { target_service_id: p[1] as string | null, resolution: String(p[2]), is_active: false });
    } else if (statement.includes('SELECT "id", "is_active" FROM "service_categories"')) {
      return categories.has(String(p[0])) ? [categories.get(String(p[0]))] : [];
    } else if (statement.includes('SELECT "id", "is_active" FROM "services"')) {
      return services.has(String(p[0])) ? [services.get(String(p[0]))] : [];
    } else if (statement.includes('SELECT "fixed_labor_price_vnd", "is_active"')) {
      return variants.has(String(p[0]) + ':' + String(p[1])) ? [variants.get(String(p[0]) + ':' + String(p[1]))] : [];
    } else if (statement.includes('SELECT "resolution", "target_service_id", "is_active"')) {
      return aliases.has(String(p[0])) ? [aliases.get(String(p[0]))] : [];
    }
    return [];
  });
  return {
    db: { transaction: async (cb: (em: unknown) => Promise<unknown>) => cb({ query }) } as never,
    categories, services, variants, aliases, sql,
  };
}

describe('inactive catalog V2 stage is isolated, non-destructive and idempotent', () => {
  it('stages 13/44/42/34 but does not touch 792 parts or historical services', async () => {
    const f = fakeDatabase();
    const first = await stageCatalogV2Inactive(f.db);
    const second = await stageCatalogV2Inactive(f.db);
    expect(first).toEqual({ categories: 13, services: 44, priceVariants: 42, aliases: 34 });
    expect(second).toEqual(first);
    expect(f.categories.size).toBe(13);
    expect(f.services.size).toBe(44);
    expect(f.variants.size).toBe(42);
    expect(f.aliases.size).toBe(34);
    const sql = f.sql.join('\n');
    expect(sql).not.toMatch(/delete from|truncate |drop table|update "services"|update "fixhome_parts"/);
    expect(sql).toContain('on conflict');
    expect([...f.variants.values()].every(v => !v.is_active)).toBe(true);
    expect([...f.aliases.values()].every(v => !v.is_active)).toBe(true);
  });
  it('rejects silently overwriting an already active category', async () => {
    const f = fakeDatabase();
    f.categories.set('CAT_AC', { id: 'existing', is_active: true });
    await expect(stageCatalogV2Inactive(f.db)).rejects.toThrow(/missing or active/);
  });
  it('rejects conflicting price after an idempotent rerun', async () => {
    const f = fakeDatabase();
    await stageCatalogV2Inactive(f.db);
    const first = f.variants.keys().next().value as string;
    f.variants.get(first)!.fixed_labor_price_vnd = 12;
    await expect(stageCatalogV2Inactive(f.db)).rejects.toThrow(/price drift/);
  });
});

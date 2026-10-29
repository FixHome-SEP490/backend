import { describe, expect, it, vi } from 'vitest';
import { applyPartsAdditions20261027, partsAdditions20261027 } from '../../src/database/catalog-v2/parts-additions-2026-10-27';
import * as base from '../../src/database/seeds/data/parts-catalog-791.json';

function fakeDatabase(existing: string[]) {
  const parts = new Map(existing.map((sku) => [sku, { selling_price: 1 }]));
  const sql: string[] = [];
  const query = vi.fn(async (statement: string, params: unknown[] = []) => {
    sql.push(statement.toLowerCase());
    const sku = String(params[0]);
    if (statement.includes('INSERT INTO "fixhome_parts"')) {
      if (parts.has(sku)) return [];
      parts.set(sku, { selling_price: Number(params[3]) });
      return [{ id: sku }];
    }
    return [];
  });
  return { db: { query } as never, parts, sql };
}

describe('Parts additions 27/10/2026', () => {
  const items = partsAdditions20261027();
  const baseSkus = new Set((((base as unknown as { default?: { sku: string }[] }).default ?? base) as unknown as { sku: string }[]).map((p) => p.sku));

  it('adds the 36 V3 electrical and lighting codes and the market-priced common parts, none already sold', () => {
    expect(items.filter((p) => /^(OUT|LGT)\d{3}$/.test(p.sku))).toHaveLength(36);
    for (const sku of ['ACG001', 'ACG003', 'RFG002', 'WHA001', 'RHD001', 'RHD002', 'TVB001', 'SHW001']) {
      expect(items.some((p) => p.sku === sku)).toBe(true);
    }
    expect(new Set(items.map((p) => p.sku)).size).toBe(items.length);
    expect(items.filter((p) => baseSkus.has(p.sku))).toEqual([]);
  });

  it('prices every part above zero, at the low end of its range, and says where the price came from', () => {
    for (const p of items) {
      expect(p.sellingPrice, p.sku).toBeGreaterThan(0);
      expect(p.description, p.sku).toMatch(/Nguồn giá: /);
      expect([0, 30, 90, 180]).toContain(p.warrantyDays);
    }
    const socket = items.find((p) => p.sku === 'OUT001')!;
    expect(socket.sellingPrice).toBe(25000);
    expect(items.find((p) => p.sku === 'ACG001')!.description).toMatch(/fptshop\.com\.vn/);
  });

  it('only inserts what is missing, never touches an existing part, and a second run changes nothing', async () => {
    const f = fakeDatabase(['OUT001']);
    const first = await applyPartsAdditions20261027(f.db);
    expect(first.skipped).toEqual(['OUT001']);
    expect(first.inserted).toHaveLength(items.length - 1);
    expect(f.parts.get('OUT001')).toEqual({ selling_price: 1 });
    expect(f.sql.some((s) => s.includes('update') || s.includes('delete'))).toBe(false);
    const second = await applyPartsAdditions20261027(f.db);
    expect(second.inserted).toEqual([]);
  });
});

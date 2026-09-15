import { describe, expect, it, vi } from 'vitest';
import { FixHomePartCatalog1725898000000 } from '../../src/database/migrations/1725898000000-FixHomePartCatalog';

const FORBIDDEN_TOKENS = [
  'stock',
  'warehouse',
  'supplier',
  'purchase_order',
  'inventory',
  'reorder',
  'bin',
];

describe('FixHomePartCatalog1725898000000', () => {
  it('creates the lightweight catalog table with checks/indexes and no inventory scope', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new FixHomePartCatalog1725898000000().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('create table if not exists "fixhome_parts"');
    expect(sql).toContain('"sku" varchar(100)');
    expect(sql).toContain('"name" varchar(200)');
    expect(sql).toContain('"selling_price" numeric(12,2)');
    expect(sql).toContain('"warranty_days" integer');
    expect(sql).toContain('"warranty_policy"');
    expect(sql).toContain('"is_active" boolean');
    expect(sql).toContain('chk_fixhome_parts_selling_price');
    expect(sql).toContain('"selling_price" >= 0');
    expect(sql).toContain('chk_fixhome_parts_warranty_days');
    expect(sql).toContain('"warranty_days" <= 3650');
    expect(sql).toContain('idx_fixhome_parts_sku');
    expect(sql).toContain('idx_fixhome_parts_is_active');
    for (const token of FORBIDDEN_TOKENS) {
      expect(sql).not.toContain(token);
    }
  });

  it('drops only the catalog table on down', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new FixHomePartCatalog1725898000000().down(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('drop table if exists "fixhome_parts"');
    expect(sql).not.toContain('cascade');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CatalogV2VariantAndAlias1790000000037 } from '../../src/database/migrations/1790000000037-CatalogV2VariantAndAlias';

describe('CatalogV2VariantAndAlias1790000000037 (additive only)', () => {
  it('creates inactive price variants and dormant alias map without touching legacy data', async () => {
    const queries: string[] = [];
    const qr = { query: vi.fn(async (sql: string) => { queries.push(sql); return []; }) } as any;
    await new CatalogV2VariantAndAlias1790000000037().up(qr);
    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('create table if not exists "service_price_variants"');
    expect(sql).toContain('"device_attributes" jsonb');
    expect(sql).toContain('"fixed_labor_price_vnd" bigint');
    expect(sql).toContain('check ("fixed_labor_price_vnd" >= 0)');
    expect(sql).toContain('"is_active" boolean not null default false');
    expect(sql).toContain('create table if not exists "service_code_aliases_v2"');
    expect(sql).toContain('"legacy_service_code" varchar(100) not null unique');
    expect(sql).toContain("'clarify'");
    expect(sql).toContain('uq_service_code_aliases_v2_auto');
    expect(sql).not.toContain('delete from');
    expect(sql).not.toContain('truncate');
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('update "fixhome_parts"');
    expect(sql).not.toContain('update "services"');
  });

  it('guards against destructive rollback when staged tables contain records', async () => {
    const queries: string[] = [];
    const qr = {
      isTransactionActive: true,
      query: vi.fn(async (sql: string) => { queries.push(sql); return []; }),
    } as any;
    await new CatalogV2VariantAndAlias1790000000037().down(qr);
    expect(queries[0].toLowerCase().replace(/\s+/g, ' ').trim()).toContain(
      'lock table "service_price_variants", "service_code_aliases_v2" in access exclusive mode',
    );
    const guard = queries[1].toLowerCase();
    expect(guard).toContain('do $catalog_guard$ begin');
    expect(guard).toContain('end $catalog_guard$');
    expect(guard).toContain('refusing destructive rollback');
    expect(guard).toContain('select 1 from "service_price_variants"');
    expect(guard).toContain('select 1 from "service_code_aliases_v2"');
    expect(queries.slice(1).join('\n').toLowerCase()).not.toContain('cascade');
  });

  it('fails safely before rollback SQL when no transaction is active', async () => {
    const query = vi.fn(async () => []);
    const queryRunner = { isTransactionActive: false, query } as any;

    await expect(new CatalogV2VariantAndAlias1790000000037().down(queryRunner))
      .rejects.toThrow('active transaction');
    expect(query).not.toHaveBeenCalled();
  });
});

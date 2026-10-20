import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { ServicesService } from '../../src/modules/services/services.service';
import { CategoriesService } from '../../src/modules/categories/categories.service';
import { Service } from '../../src/modules/services/entities/service.entity';
import { ServiceCategory } from '../../src/modules/categories/entities/category.entity';
import { CATALOG_V2_APPROVED_FIXED_TIERS } from '../../src/database/catalog-v2/catalog-v2-approved-price-tiers';
import { addCatalogV2PriceSummaries } from '../../src/database/catalog-v2/catalog-v2-price-summary';

const service = (code: string, isActive = true) => Object.assign(new Service(), {
  id: code, code, isActive, fixedPrice: null, category: { isActive: true },
});
const tier = (code: string) => {
  const approved = CATALOG_V2_APPROVED_FIXED_TIERS.find(t => t.variantCode === code)!;
  return { service_id: approved.serviceCode, variant_code: code,
    fixed_labor_price_vnd: String(approved.laborPriceVnd), included_scope: approved.conditionVi,
    excluded_scope: null, is_active: true };
};

describe('public Catalog V2 price summaries', () => {
  it('adds the same DB-backed summaries to paged, nested and detail reads with one batch per response; leaves admin reads alone', async () => {
    const rows = [tier('AC-02-01'), tier('AC-02-03'), tier('WM-03-09')];
    const query = vi.fn().mockResolvedValue(rows);
    const items = () => ['AC-02', 'WM-03', 'AC-01', 'LEGACY'].map(code => service(code));
    const qb = { leftJoinAndSelect: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(),
      getManyAndCount: vi.fn().mockImplementation(async () => [items(), 4]) };
    const repo = { manager: { query }, createQueryBuilder: () => qb,
      findOne: vi.fn().mockImplementation(async () => service('AC-02')) };
    const categoryRepo = { manager: { query }, find: vi.fn().mockImplementation(async () => [
      { services: [...items(), service('WM-02', false)] },
    ]) };
    const services = new ServicesService(repo as unknown as Repository<Service>, {} as Repository<ServiceCategory>);
    const categories = new CategoriesService(categoryRepo as unknown as Repository<ServiceCategory>);
    const expected = [
      { kind: 'fixed_range', minLaborVnd: 199000, maxLaborVnd: 449000 },
      { kind: 'fixed_range', minLaborVnd: 299000, maxLaborVnd: 299000 },
      { kind: 'inspection_reference', minLaborVnd: 249000, maxLaborVnd: 449000, suggestedLaborVnd: 249000 },
      undefined,
    ];
    const page = await services.findServices({ page: 1, limit: 10, skip: 0 }, true);
    expect(page.data.map(s => (s as any).priceSummary)).toEqual(expected);
    expect(page.meta).toEqual({ page: 1, limit: 10, total: 4, totalPages: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('is_active = true');
    expect(query.mock.calls[0][1]).toEqual([['AC-02', 'WM-03', 'AC-01']]);
    const nested = await categories.findAll(true);
    expect(nested[0].services.map(s => (s as any).priceSummary)).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(2);
    expect(await services.findByIdOrSlug('ac-cleaning', true)).toHaveProperty('priceSummary', expected[0]);
    expect(query).toHaveBeenCalledTimes(3);
    expect((await services.findServices({ page: 1, limit: 10, skip: 0 })).data[0]).not.toHaveProperty('priceSummary');
    expect((await categories.findAll(false))[0].services[0]).not.toHaveProperty('priceSummary');
    expect(await services.findByIdOrSlug('ac-cleaning')).not.toHaveProperty('priceSummary');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fails closed on inconsistent active tiers and never invents a floor or exposes gated/legacy/inactive references', async () => {
    const fallback = { kind: 'inspection_only', minLaborVnd: null, maxLaborVnd: null };
    for (const invalid of [
      { ...tier('AC-02-01'), fixed_labor_price_vnd: '1' },
      { ...tier('AC-02-01'), included_scope: 'different scope' },
      { ...tier('AC-02-01'), excluded_scope: 'extra exclusion' },
      { ...tier('AC-02-01'), variant_code: 'UNKNOWN' },
    ]) {
      const result = await addCatalogV2PriceSummaries({ query: vi.fn().mockResolvedValue([tier('AC-02-03'), invalid]) }, [service('AC-02')]);
      expect(result[0].priceSummary).toEqual(fallback);
    }
    const query = vi.fn().mockResolvedValue([tier('AC-02-01'), tier('AC-02-01')]);
    const result = await addCatalogV2PriceSummaries({ query }, [service('AC-02'), service('WM-03'), service('KT-04'), service('KT-05'), service('TV-02'), service('LK-01'), service('LEGACY'), service('AC-01', false)]);
    expect(result.slice(0, 2).map(s => s.priceSummary)).toEqual([fallback, fallback]);
    for (const item of result.slice(2)) expect(item).not.toHaveProperty('priceSummary');
    query.mockResolvedValue([{ ...tier('AC-02-01'), is_active: false }]);
    expect((await addCatalogV2PriceSummaries({ query }, [service('AC-02')]))[0].priceSummary).toEqual(fallback);
    query.mockClear();
    await addCatalogV2PriceSummaries({ query }, [service('LEGACY')]);
    expect(query).not.toHaveBeenCalled();
  });
});

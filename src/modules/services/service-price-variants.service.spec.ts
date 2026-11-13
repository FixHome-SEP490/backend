import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ServicePriceVariantsService } from './service-price-variants.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'v1', service_id: 's1', variant_code: 'AC-INSTALL-9K', device_attributes: { btu: 9000 },
  fixed_labor_price_vnd: '450000', included_scope: 'Lắp dàn nóng, dàn lạnh', excluded_scope: null,
  is_active: true, updated_at: '2026-11-13T00:00:00Z', ...over,
});

function build(before: unknown, after: unknown) {
  const m = { query: vi.fn().mockResolvedValueOnce(before ? [before] : []).mockResolvedValueOnce([after]) };
  const audit = { logWithManager: vi.fn() };
  const service = new ServicePriceVariantsService({ query: vi.fn().mockResolvedValue([row()]), transaction: (w: any) => w(m) } as any, audit as any);
  return { service, m, audit };
}

describe('ADMIN 47 service price tiers', () => {
  it('lists the tiers of a service with numeric prices', async () => {
    const { service } = build(null, null);
    expect(await service.list('s1')).toEqual([expect.objectContaining({ variantCode: 'AC-INSTALL-9K', fixedLaborPriceVnd: 450000, isActive: true })]);
  });
  it('changes price and active flag under a row lock and audits before/after', async () => {
    const { service, m, audit } = build(row(), row({ fixed_labor_price_vnd: '500000', is_active: false }));
    const out = await service.update('s1', 'v1', { fixedLaborPriceVnd: 500000, isActive: false }, { id: 'admin', role: 'admin' });
    expect(out).toMatchObject({ fixedLaborPriceVnd: 500000, isActive: false });
    expect(m.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(m.query.mock.calls[1][1]).toEqual(['v1', 's1', 500000, null, null, false]);
    expect(audit.logWithManager).toHaveBeenCalledWith(m, expect.objectContaining({ action: 'SERVICE_PRICE_VARIANT_UPDATE',
      before: expect.objectContaining({ fixedLaborPriceVnd: 450000 }), after: expect.objectContaining({ fixedLaborPriceVnd: 500000 }) }));
  });
  it('refuses a tier of another service', async () => {
    const { service, audit } = build(null, null);
    await expect(service.update('s2', 'v1', { isActive: false }, { id: 'a', role: 'admin' })).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.logWithManager).not.toHaveBeenCalled();
  });
});

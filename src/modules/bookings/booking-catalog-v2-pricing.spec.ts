import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { toBookingResponse } from './booking-privacy.dto';
import { CATALOG_V2_APPROVED_FIXED_TIERS as tiers } from '../../database/catalog-v2/catalog-v2-approved-price-tiers';

function fixture(code = 'AC-02') {
  const record = { id: 'service', code, name: 'Synthetic', isActive: true,
    pricingMode: 'inspection_required', fixedPrice: null };
  const bookingRepo = { create: (v: object) => v, save: async (v: object) => ({ id: 'booking', ...v }) };
  const rows = tiers.filter(t => t.serviceCode === code).map((t, i) => ({ id: `variant-${i}`, service_id: 'service', variant_code: t.variantCode,
    fixed_labor_price_vnd: String(t.laborPriceVnd), included_scope: t.conditionVi, excluded_scope: null, is_active: true }));
  const manager = { query: vi.fn(async (sql: string) => sql.includes('JOIN service_categories') ? [{ code }] : rows),
    getRepository: (entity: unknown) => entity === Booking ? bookingRepo : {} };
  const instance = Object.create(BookingsService.prototype) as BookingsService;
  Object.assign(instance, { userRepo: { findOneBy: async () => ({ id: 'customer' }) },
    serviceRepo: { findOneBy: async () => record }, addressRepo: { findOneBy: async () => ({ userId: 'customer', line1: 'Synthetic', lat: 10, lng: 106 }) },
    dataSource: { transaction: async (fn: (m: unknown) => unknown) => fn(manager) }, auditLogService: { log: async () => {} },
    configService: { getInt: async (_: string, fallback: number) => fallback } });
  const dto = { serviceId: 'service', addressId: 'address', description: 'Synthetic',
    preferredStartAt: '2030-10-21T01:00:00Z', preferredEndAt: '2030-10-21T05:00:00Z' };
  return { instance, dto, record, rows, manager };
}

describe('Booking Catalog V2 persistence', () => {
  it('snapshots the active exact tier and scope instead of changing generic parent price', async () => {
    const f = fixture();
    const created = await f.instance.create({ ...f.dto, deviceAttributes: { acMounting: 'wall', acHorsepower: 'up_to_1_5' } }, { id: 'customer', role: 'customer' });
    expect(created).toMatchObject({ pricingModeSnapshot: 'fixed_price', fixedUnitPriceSnapshot: 199000,
      scopeSnapshot: 'Treo tường <=1.5 HP', catalogV2PricingSnapshot: { selectedVariant: { variantId: 'variant-0', variantCode: 'AC-02-01' } } });
    expect(toBookingResponse(created)).toHaveProperty('catalogV2PricingSnapshot.selectedVariant.variantCode', 'AC-02-01');
    expect(f.record.fixedPrice).toBeNull();
    expect(f.manager.query.mock.calls[0][0]).toContain('FOR SHARE');
  });

  it('persists inspection and null S when scope or facts are missing, even if parent has a fixed price', async () => {
    const f = fixture();
    Object.assign(f.record, { pricingMode: 'fixed_price', fixedPrice: 1 });
    const created = await f.instance.create(f.dto, { id: 'customer', role: 'customer' });
    expect(created).toMatchObject({ pricingModeSnapshot: 'inspection_required', fixedUnitPriceSnapshot: null, scopeSnapshot: null,
      catalogV2PricingSnapshot: { selectedVariant: null, priceRange: { minLaborVnd: 199000, maxLaborVnd: 449000 } } });
  });

  it('rejects explicit mismatched selection', async () => {
    const f = fixture();
    await expect(f.instance.create({ ...f.dto, selectedVariantCode: 'WM-02-05' } as never, { id: 'customer', role: 'customer' })).rejects.toThrow();
  });

  it('preserves legacy fixed pricing and rejects injecting a V2 variant into legacy', async () => {
    const f = fixture('VE_SINH_DIEU_HOA_1HP');
    Object.assign(f.record, { pricingMode: 'fixed_price', fixedPrice: 175000, scopeDescription: 'Legacy scope' });
    const created = await f.instance.create(f.dto, { id: 'customer', role: 'customer' });
    expect(created).toMatchObject({ pricingModeSnapshot: 'fixed_price', fixedUnitPriceSnapshot: 175000, scopeSnapshot: 'Legacy scope', catalogV2PricingSnapshot: null });
    expect(f.manager.query).not.toHaveBeenCalled();
    await expect(f.instance.create({ ...f.dto, selectedVariantCode: 'AC-02-01' } as never, { id: 'customer', role: 'customer' })).rejects.toThrow();
  });
});

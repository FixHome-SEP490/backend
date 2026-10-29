import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { CostItemType, PartSource } from '../../shared/enums';
import { VoucherCampaign, VoucherReservation } from '../vouchers/entities/voucher.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VoucherDiscount } from '../vouchers/voucher.types';
import { loadVoucherPreviewInvoices } from '../vouchers/voucher-checkout-preview';
import { FinanceService } from './finance.service';

vi.mock('../vouchers/voucher-checkout-preview', () => ({ loadVoucherPreviewInvoices: vi.fn() }));

const reservedAt = new Date('2026-10-26T15:00:00Z');
const expiresAt = new Date('2026-10-26T15:15:00Z');
const policy = { discount: VoucherDiscount.PERCENT, value: 50, capVnd: null,
  minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] as ['LABOR', 'PARTS'] };
const facts = { invoices: [{ invoiceId: 'invoice-1', successful: true,
  originalGrossVnd: 100000, laborTotalVnd: 100000, fixHomePartsTotalVnd: 0,
  commissionRateSnapshot: 0.1, commissionAmountVnd: 10000,
  originalPlatformDueVnd: 10000, technicianEntitlementVnd: 90000,
  items: [{ invoiceId: 'invoice-1', type: CostItemType.LABOR,
    partSource: PartSource.FIXHOME, quantity: 1, unitPriceVnd: 100000, lineTotalVnd: 100000 }] }],
  services: [{ serviceId: 'service-1', categoryId: 'category-1' }] };

function setup(scopeKind: 'SOLO' | 'VISIT_GROUP' = 'SOLO') {
  const reservation = { id: 'reservation-1', customerId: 'customer-1', scopeId: 'scope-1',
    campaignId: 'campaign-1',
    state: 'RESERVED', reservedAt, expiresAt, policySnapshot: policy,
    checkoutSnapshot: { eligibleSubtotalVnd: 100000 } };
  const manager = {
    queryRunner: { isTransactionActive: true },
    findOne: vi.fn(async (entity: unknown) => entity === VoucherReservation ? reservation
      : entity === VoucherCampaign ? { id: 'campaign-1' } : null),
    findOneBy: vi.fn(async (entity: unknown) => entity === VisitGroup && scopeKind === 'VISIT_GROUP'
      ? { id: 'scope-1', customerId: 'customer-1' } : null),
    query: vi.fn(async () => [{ now: new Date('2026-10-26T15:01:00Z') }]),
  } as unknown as EntityManager;
  vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue(facts);
  return { manager, reservation };
}

describe('Finance server voucher rail quote', () => {
  it.each([
    ['SOLO', 'WALLET'], ['SOLO', 'VNPAY'], ['SOLO', 'CASH'],
    ['VISIT_GROUP', 'WALLET'], ['VISIT_GROUP', 'VNPAY'], ['VISIT_GROUP', 'CASH'],
  ] as const)('derives %s %s due from frozen server invoices, preserving gross and entitlement', async (scopeKind, rail) => {
    const { manager } = setup(scopeKind);
    const service = Object.create(FinanceService.prototype) as FinanceService;
    const quote = await service.quoteVoucherRail(manager, {
      reservationId: 'reservation-1', customerId: 'customer-1', scopeId: 'scope-1',
      scopeKind, rail, invoiceId: scopeKind === 'SOLO' ? 'invoice-1' : undefined,
    });
    expect(quote.total).toMatchObject({ originalGrossVnd: 100000,
      customerDueVnd: 50000, fixHomeDiscountSubsidyVnd: 50000,
      originalCommissionAmountVnd: 10000, originalPlatformDueVnd: 10000,
      technicianEntitlementVnd: 90000 });
    expect(loadVoucherPreviewInvoices).toHaveBeenCalledWith(manager, 'customer-1', 'scope-1', true);
  });

  it.each(['wrong customer', 'wrong scope', 'expired', 'changed eligible base', 'wrong invoice'])(
    'rejects %s before a rail may create a payment record', async (caseName) => {
      const { manager, reservation } = setup();
      const service = Object.create(FinanceService.prototype) as FinanceService;
      if (caseName === 'expired') vi.mocked(manager.query).mockResolvedValue([{ now: expiresAt }] as never);
      if (caseName === 'changed eligible base') reservation.checkoutSnapshot.eligibleSubtotalVnd = 100001;
      await expect(service.quoteVoucherRail(manager, {
        reservationId: 'reservation-1', customerId: caseName === 'wrong customer' ? 'other' : 'customer-1',
        scopeId: caseName === 'wrong scope' ? 'other' : 'scope-1', scopeKind: 'SOLO', rail: 'WALLET',
        invoiceId: caseName === 'wrong invoice' ? 'other' : 'invoice-1',
      })).rejects.toThrow();
    },
  );

  it.each(['SOLO', 'VISIT_GROUP'] as const)('rejects a %s reservation used as the opposite scope type', async (actualKind) => {
    const { manager } = setup(actualKind);
    const service = Object.create(FinanceService.prototype) as FinanceService;
    await expect(service.quoteVoucherRail(manager, {
      reservationId: 'reservation-1', customerId: 'customer-1', scopeId: 'scope-1',
      scopeKind: actualKind === 'SOLO' ? 'VISIT_GROUP' : 'SOLO', rail: 'WALLET',
      invoiceId: actualKind === 'SOLO' ? undefined : 'invoice-1',
    })).rejects.toThrow();
  });
  it('locks campaign before reservation to match apply, sweep and quota redemption', async () => {
    const { manager } = setup();
    const service = Object.create(FinanceService.prototype) as FinanceService;
    await service.quoteVoucherRail(manager, {
      reservationId: 'reservation-1', customerId: 'customer-1', scopeId: 'scope-1',
      scopeKind: 'SOLO', rail: 'WALLET', invoiceId: 'invoice-1',
    });
    const calls = vi.mocked(manager.findOne).mock.calls;
    expect(calls.map(([entity, options]) => [entity, (options as any)?.lock?.mode])).toEqual([
      [VoucherReservation, undefined],
      [VoucherCampaign, 'pessimistic_write'],
      [VoucherReservation, 'pessimistic_write'],
    ]);
  });

  it('accepts a verified fully funded quote only on the ZERO rail', async () => {
    const { manager, reservation } = setup();
    reservation.policySnapshot = { ...policy, value: 100 };
    const service = Object.create(FinanceService.prototype) as FinanceService;
    const input = { reservationId: 'reservation-1', customerId: 'customer-1',
      scopeId: 'scope-1', scopeKind: 'SOLO' as const, invoiceId: 'invoice-1' };
    const quote = await service.quoteVoucherRail(manager, { ...input, rail: 'ZERO' });
    expect(quote.total.customerDueVnd).toBe(0);
    await expect(service.quoteVoucherRail(manager, { ...input, rail: 'WALLET' })).rejects.toThrow();
  });
});

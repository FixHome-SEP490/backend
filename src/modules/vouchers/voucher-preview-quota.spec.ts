import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Role, CostItemType } from '../../shared/enums';
import { VoucherClaim, VoucherCampaign, VoucherReservation } from './entities/voucher.entity';
import { ReservationState, VoucherDiscount } from './voucher.types';
import { VouchersService } from './vouchers.service';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';

vi.mock('./voucher-checkout-preview', () => ({ loadVoucherPreviewInvoices: vi.fn() }));

const invoiceFacts = {
  invoices: [{
    invoiceId: 'invoice-1', successful: true, originalGrossVnd: 100000,
    laborTotalVnd: 100000, fixHomePartsTotalVnd: 0, commissionRateSnapshot: 0.1,
    commissionAmountVnd: 10000, originalPlatformDueVnd: 10000,
    technicianEntitlementVnd: 90000,
    items: [{ invoiceId: 'invoice-1', type: CostItemType.LABOR,
      quantity: 1, unitPriceVnd: 100000, lineTotalVnd: 100000 }],
  }],
  services: [{ serviceId: 'service-1', categoryId: 'category-1' }],
};

describe('BUG #47 — read-only voucher checkout preview quota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue(invoiceFacts);
  });

  it.each([
    { label: 'redeemed campaign exhausted', redeemed: 1, quota: 1, held: 0, blocked: true },
    { label: 'last slot reserved', redeemed: 0, quota: 1, held: 1, blocked: true },
    { label: 'unverified expired hold still uses slot', redeemed: 0, quota: 1, held: 1, blocked: true },
    { label: 'unreserved campaign capacity available', redeemed: 1, quota: 2, held: 0, blocked: false },
  ])('$label', async ({ redeemed, quota, held, blocked }) => {
    const customer = { id: randomUUID(), role: Role.CUSTOMER };
    const claimId = randomUUID();
    const scopeId = randomUUID();
    const policy = {
      discount: VoucherDiscount.PERCENT, value: 50, capVnd: null,
      minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'],
    };
    const campaign = {
      id: 'campaign-1', active: true, redeemed, quota,
      startsAt: new Date(Date.now() - 60000),
      endsAt: new Date(Date.now() + 60000),
    };
    const manager = {
      findOneBy: vi.fn(async (entity: unknown) => entity === VoucherClaim
        ? { id: claimId, campaignId: campaign.id, customerId: customer.id, redeemedAt: null, policySnapshot: policy }
        : entity === VoucherCampaign ? campaign : null),
      count: vi.fn(async (entity: unknown, options: { where: { campaignId: string; state: ReservationState } }) => {
        expect(entity).toBe(VoucherReservation);
        expect(options.where).toEqual({ campaignId: campaign.id, state: ReservationState.RESERVED });
        return held;
      }),
      query: vi.fn(async () => [{ now: new Date() }]),
      save: vi.fn(), update: vi.fn(), delete: vi.fn(),
    };
    const database = {
      query: async () => [{ ready: true }],
      transaction: async (work: (manager: unknown) => unknown) => work(manager),
    };
    const service = new VouchersService(database as never, {} as never);
    if (blocked) {
      await expect(service.checkoutPreview(customer, claimId, scopeId))
        .rejects.toMatchObject({ status: 409 });
      expect(loadVoucherPreviewInvoices).not.toHaveBeenCalled();
    } else {
      await expect(service.checkoutPreview(customer, claimId, scopeId))
        .resolves.toMatchObject({ previewOnly: true, customerDueVnd: 50000 });
    }
    expect(manager.count).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });
});

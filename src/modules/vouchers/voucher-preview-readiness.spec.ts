import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { VouchersService } from './vouchers.service';
import { VoucherClaim, VoucherCampaign } from './entities/voucher.entity';
import { VoucherDiscount } from './voucher.types';
import { Role, CostItemType } from '../../shared/enums';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';

vi.mock('./voucher-checkout-preview', () => ({ loadVoucherPreviewInvoices: vi.fn() }));

describe('voucher preview readiness signal', () => {
  it.each([true, false])('advertises payment availability only from schema evidence (%s)', async ready => {
    const customer = { id: randomUUID(), role: Role.CUSTOMER };
    const claimId = randomUUID();
    const scopeId = randomUUID();
    const policy = { discount: VoucherDiscount.PERCENT, value: 50, capVnd: null,
      minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] };
    const manager = { findOneBy: async (entity: unknown) => entity === VoucherClaim
      ? { id: claimId, customerId: customer.id, campaignId: 'campaign-1', redeemedAt: null, policySnapshot: policy }
      : entity === VoucherCampaign ? { active: true, redeemed: 0, quota: 1, startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 60000) } : null,
      count: vi.fn().mockResolvedValue(0), query: async () => [{ now: new Date() }], save: vi.fn(),
    };
    vi.mocked(loadVoucherPreviewInvoices).mockResolvedValue({
      invoices: [{ invoiceId: 'invoice-1', successful: true, originalGrossVnd: 100000,
        laborTotalVnd: 100000, fixHomePartsTotalVnd: 0, commissionRateSnapshot: 0.1,
        commissionAmountVnd: 10000, originalPlatformDueVnd: 10000, technicianEntitlementVnd: 90000,
        items: [{ invoiceId: 'invoice-1', type: CostItemType.LABOR, quantity: 1, unitPriceVnd: 100000, lineTotalVnd: 100000 }] }],
      services: [{ serviceId: 'service-1', categoryId: 'category-1' }],
    });
    const database = { query: async () => [{ ready }], transaction: async (work: (m: unknown) => unknown) => work(manager) };
    const service = new VouchersService(database as never, {} as never);
    expect(await service.checkoutPreview(customer, claimId, scopeId)).toMatchObject({
      previewOnly: true, paymentAvailable: ready, customerDueVnd: 50000,
    });
    expect(manager.save).not.toHaveBeenCalled();
  });
});

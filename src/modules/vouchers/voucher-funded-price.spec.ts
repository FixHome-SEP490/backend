import { describe, expect, it } from 'vitest';
import { CostItemType } from '../../shared/enums/cost-item-type.enum';
import { PartSource } from '../../shared/enums/part-source.enum';
import { VoucherDiscount, type VoucherPolicy } from './voucher.types';
import { calculateVoucherFundedPrice } from './voucher-funded-price';
import type { VoucherFundingInvoiceFacts } from './voucher-funding.types';

const percentPolicy = (
  value: number,
  overrides: Partial<VoucherPolicy> = {},
): VoucherPolicy => ({
  discount: VoucherDiscount.PERCENT,
  value,
  capVnd: null,
  minimumVnd: 0,
  categoryIds: [],
  serviceIds: [],
  components: ['LABOR', 'PARTS'],
  ...overrides,
});

const fixedPolicy = (
  value: number,
  overrides: Partial<VoucherPolicy> = {},
): VoucherPolicy => ({
  ...percentPolicy(value, overrides),
  discount: VoucherDiscount.FIXED,
});

const invoice = (
  overrides: Partial<VoucherFundingInvoiceFacts> = {},
) => ({
  invoiceId: 'invoice-a',
  successful: true,
  originalGrossVnd: 500_000,
  laborTotalVnd: 200_000,
  fixHomePartsTotalVnd: 300_000,
  commissionRateSnapshot: 0.1,
  commissionAmountVnd: 20_000,
  originalPlatformDueVnd: 320_000,
  technicianEntitlementVnd: 180_000,
  items: [
    {
      invoiceId: 'invoice-a',
      type: CostItemType.PARTS_EQUIPMENT,
      partSource: PartSource.FIXHOME,
      partCatalogId: 'catalog-part-a',
      quantity: 1,
      unitPriceVnd: 300_000,
      lineTotalVnd: 300_000,
    },
  ],
  ...overrides,
});

describe('calculateVoucherFundedPrice', () => {
  it('rejects non-array invoice input rather than producing a discounted checkout', () => {
    expect(() => calculateVoucherFundedPrice({ policy: percentPolicy(10), invoices: null } as unknown as Parameters<typeof calculateVoucherFundedPrice>[0])).toThrow(TypeError);
  });

  it('excludes an entire invoice if its valid FixHome part lines exceed its frozen part subtotal', () => {
    const inconsistent = invoice({
      fixHomePartsTotalVnd: 100_000,
    });
    const result = calculateVoucherFundedPrice({ policy: percentPolicy(10), invoices: [inconsistent] });
    expect(result).toMatchObject({
      originalGrossVnd: 0,
      eligibleBaseVnd: 0,
      fixHomeDiscountSubsidyVnd: 0,
      customerDueVnd: 0,
    });
    expect(result.reasonCodes).toContain('INVALID_INVOICE_EXCLUDED');
    expect(result.invoiceSnapshots).toHaveLength(0);
  });
  it('applies 10% to frozen labor and used FixHome parts while preserving original money snapshots', () => {
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [invoice()],
    });

    expect(result).toMatchObject({
      originalGrossVnd: 500_000,
      eligibleBaseVnd: 500_000,
      fixHomeDiscountSubsidyVnd: 50_000,
      customerDueVnd: 450_000,
      originalCommissionAmountVnd: 20_000,
      originalPlatformDueVnd: 320_000,
      technicianEntitlementVnd: 180_000,
    });
    expect(result.invoiceSnapshots).toEqual([
      {
        invoiceId: 'invoice-a',
        originalGrossVnd: 500_000,
        commissionRateSnapshot: 0.1,
        commissionAmountVnd: 20_000,
        originalPlatformDueVnd: 320_000,
        technicianEntitlementVnd: 180_000,
      },
    ]);
  });

  it('prices one used FixHome unit when two were approved', () => {
    const approvedQuantity = 2;
    const frozenInvoice = invoice({
      originalGrossVnd: 500_000,
      fixHomePartsTotalVnd: 300_000,
      items: [
        {
          invoiceId: 'invoice-a',
          type: CostItemType.PARTS_EQUIPMENT,
          partSource: PartSource.FIXHOME,
          partCatalogId: 'catalog-part-a',
          quantity: 1,
          unitPriceVnd: 300_000,
          lineTotalVnd: 300_000,
        },
      ],
    });

    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [frozenInvoice],
    });

    expect(approvedQuantity).toBe(2);
    expect(result.eligibleBaseVnd).toBe(500_000);
    expect(result.fixHomeDiscountSubsidyVnd).toBe(50_000);
  });

  it('excludes legacy technician and external part lines from eligible base', () => {
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [
        invoice({
          originalGrossVnd: 900_000,
          items: [
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.FIXHOME,
              partCatalogId: 'catalog-part-a',
              quantity: 1,
              unitPriceVnd: 300_000,
              lineTotalVnd: 300_000,
            },
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.TECHNICIAN,
              partCatalogId: 'legacy-tech-part',
              quantity: 1,
              unitPriceVnd: 200_000,
              lineTotalVnd: 200_000,
            },
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.EXTERNAL,
              partCatalogId: 'external-part',
              quantity: 1,
              unitPriceVnd: 200_000,
              lineTotalVnd: 200_000,
            },
          ],
        }),
      ],
    });

    expect(result.originalGrossVnd).toBe(900_000);
    expect(result.eligibleBaseVnd).toBe(500_000);
    expect(result.fixHomeDiscountSubsidyVnd).toBe(50_000);
    expect(result.customerDueVnd).toBe(850_000);
  });

  it('excludes a failed VisitGroup child from gross, eligibility, and preserved snapshots', () => {
    const failed = invoice({
      invoiceId: 'invoice-failed',
      successful: false,
      originalGrossVnd: 900_000,
      laborTotalVnd: 900_000,
      fixHomePartsTotalVnd: 0,
      commissionAmountVnd: 90_000,
      originalPlatformDueVnd: 90_000,
      technicianEntitlementVnd: 810_000,
      items: [],
    });
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [invoice(), failed],
    });

    expect(result.originalGrossVnd).toBe(500_000);
    expect(result.eligibleBaseVnd).toBe(500_000);
    expect(result.fixHomeDiscountSubsidyVnd).toBe(50_000);
    expect(result.customerDueVnd).toBe(450_000);
    expect(result.originalCommissionAmountVnd).toBe(20_000);
    expect(result.originalPlatformDueVnd).toBe(320_000);
    expect(result.technicianEntitlementVnd).toBe(180_000);
    expect(result.invoiceSnapshots).toHaveLength(1);
    expect(result.reasonCodes).toContain('FAILED_CHILD_EXCLUDED');
  });

  it('applies a fixed VND discount and caps it at eligible spend', () => {
    const result = calculateVoucherFundedPrice({
      policy: fixedPolicy(600_000),
      invoices: [invoice()],
    });

    expect(result.fixHomeDiscountSubsidyVnd).toBe(500_000);
    expect(result.customerDueVnd).toBe(0);
  });

  it('caps a percentage discount and does not apply below minimum spend', () => {
    const capped = calculateVoucherFundedPrice({
      policy: percentPolicy(20, { capVnd: 30_000 }),
      invoices: [invoice()],
    });
    const belowMinimum = calculateVoucherFundedPrice({
      policy: percentPolicy(10, { minimumVnd: 500_001 }),
      invoices: [invoice()],
    });

    expect(capped.fixHomeDiscountSubsidyVnd).toBe(30_000);
    expect(capped.customerDueVnd).toBe(470_000);
    expect(belowMinimum.fixHomeDiscountSubsidyVnd).toBe(0);
    expect(belowMinimum.customerDueVnd).toBe(500_000);
    expect(belowMinimum.reasonCodes).toContain('MINIMUM_SPEND_NOT_MET');
  });

  it('rounds percentage discounts to the nearest VND with half amounts rounded up', () => {
    const tinyInvoice = invoice({
      originalGrossVnd: 5,
      laborTotalVnd: 5,
      fixHomePartsTotalVnd: 0,
      commissionAmountVnd: 1,
      originalPlatformDueVnd: 1,
      technicianEntitlementVnd: 4,
      items: [],
    });
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(50),
      invoices: [tinyInvoice],
    });

    expect(result.fixHomeDiscountSubsidyVnd).toBe(3);
    expect(result.customerDueVnd).toBe(2);
  });

  it('ignores foreign and malformed part lines without changing frozen gross', () => {
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [
        invoice({
          items: [
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.FIXHOME,
              partCatalogId: 'catalog-part-a',
              quantity: 1,
              unitPriceVnd: 300_000,
              lineTotalVnd: 300_000,
            },
            {
              invoiceId: 'invoice-other',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.FIXHOME,
              partCatalogId: 'foreign-catalog-part',
              quantity: 1,
              unitPriceVnd: 900_000,
              lineTotalVnd: 900_000,
            },
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.FIXHOME,
              partCatalogId: 'malformed-catalog-part',
              quantity: -1,
              unitPriceVnd: 900_000,
              lineTotalVnd: -900_000,
            },
            {
              invoiceId: 'invoice-a',
              type: CostItemType.PARTS_EQUIPMENT,
              partSource: PartSource.FIXHOME,
              partCatalogId: '',
              quantity: 1,
              unitPriceVnd: 700_000,
              lineTotalVnd: 700_000,
            },
          ],
        }),
      ],
    });

    expect(result.originalGrossVnd).toBe(500_000);
    expect(result.eligibleBaseVnd).toBe(500_000);
    expect(result.fixHomeDiscountSubsidyVnd).toBe(50_000);
    expect(result.reasonCodes).toContain('FOREIGN_LINE_EXCLUDED');
    expect(result.reasonCodes).toContain('MALFORMED_LINE_EXCLUDED');
  });

  it('returns no discount for zero eligible spend or an invalid negative invoice snapshot', () => {
    const zero = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [invoice({ laborTotalVnd: 0, fixHomePartsTotalVnd: 0, items: [] })],
    });
    const negative = calculateVoucherFundedPrice({
      policy: percentPolicy(10),
      invoices: [invoice({ originalGrossVnd: -1 })],
    });

    expect(zero.fixHomeDiscountSubsidyVnd).toBe(0);
    expect(zero.customerDueVnd).toBe(500_000);
    expect(negative.originalGrossVnd).toBe(0);
    expect(negative.fixHomeDiscountSubsidyVnd).toBe(0);
    expect(negative.customerDueVnd).toBe(0);
    expect(negative.reasonCodes).toContain('INVALID_INVOICE_EXCLUDED');
  });

  it('uses exact integer arithmetic near the safe-integer boundary', () => {
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(50),
      invoices: [
        invoice({
          originalGrossVnd: maxSafe,
          laborTotalVnd: maxSafe,
          fixHomePartsTotalVnd: 0,
          commissionAmountVnd: 0,
          originalPlatformDueVnd: 0,
          technicianEntitlementVnd: maxSafe,
          items: [],
        }),
      ],
    });

    expect(result.fixHomeDiscountSubsidyVnd).toBe(4_503_599_627_370_496);
    expect(result.customerDueVnd).toBe(4_503_599_627_370_495);
  });

  it('rejects aggregate overflow instead of wrapping or emitting an unsafe VND value', () => {
    expect(() =>
      calculateVoucherFundedPrice({
        policy: percentPolicy(10),
        invoices: [
          invoice({
            originalGrossVnd: Number.MAX_SAFE_INTEGER,
            laborTotalVnd: Number.MAX_SAFE_INTEGER,
            fixHomePartsTotalVnd: 0,
            commissionAmountVnd: 0,
            originalPlatformDueVnd: 0,
            technicianEntitlementVnd: Number.MAX_SAFE_INTEGER,
            items: [],
          }),
          invoice({
            invoiceId: 'invoice-b',
            originalGrossVnd: 1,
            laborTotalVnd: 1,
            fixHomePartsTotalVnd: 0,
            commissionAmountVnd: 0,
            originalPlatformDueVnd: 0,
            technicianEntitlementVnd: 1,
            items: [],
          }),
        ],
      }),
    ).toThrow(RangeError);
  });

  it('fails closed for an invalid discount policy', () => {
    const result = calculateVoucherFundedPrice({
      policy: percentPolicy(101),
      invoices: [invoice()],
    });

    expect(result.fixHomeDiscountSubsidyVnd).toBe(0);
    expect(result.customerDueVnd).toBe(500_000);
    expect(result.reasonCodes).toContain('INVALID_POLICY');
    expect([
      result.originalGrossVnd,
      result.eligibleBaseVnd,
      result.fixHomeDiscountSubsidyVnd,
      result.customerDueVnd,
      result.originalCommissionAmountVnd,
      result.originalPlatformDueVnd,
      result.technicianEntitlementVnd,
    ].every((amount) => Number.isSafeInteger(amount) && amount >= 0)).toBe(true);
  });
});

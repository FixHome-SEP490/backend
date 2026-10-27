import { describe, expect, it } from 'vitest';
import { CostItemType, PartSource } from '../../shared/enums';
import { VoucherDiscount, type VoucherPolicy } from './voucher.types';
import type { VoucherFundingInvoiceFacts } from './voucher-funding.types';
import {
  allocateVoucherFunding,
  calculateVoucherRefundDelta,
  resolveVoucherRefundFromCustomerNet,
  validateVoucherRefundGrossForNet,
  canRestoreVoucherAfterRefund,
} from './voucher-funding-allocation';

const policy: VoucherPolicy = {
  discount: VoucherDiscount.PERCENT, value: 100, capVnd: null,
  minimumVnd: 0, categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'],
};

function invoice(id: string, labor: number, parts = 0, other = 0): VoucherFundingInvoiceFacts {
  const gross = labor + parts + other;
  return {
    invoiceId: id, successful: true, originalGrossVnd: gross,
    laborTotalVnd: labor, fixHomePartsTotalVnd: parts,
    commissionRateSnapshot: 0.1, commissionAmountVnd: Math.round(labor * 0.1),
    originalPlatformDueVnd: parts + Math.round(labor * 0.1),
    technicianEntitlementVnd: gross - parts - Math.round(labor * 0.1),
    items: parts ? [{ invoiceId: id, type: CostItemType.PARTS_EQUIPMENT,
      partSource: PartSource.FIXHOME, partCatalogId: `catalog-${id}`,
      quantity: 1, unitPriceVnd: parts, lineTotalVnd: parts }] : [],
  };
}

describe('immutable voucher funding allocation', () => {
  it('allocates only successful A and C, including 0 VND customer due, without changing original snapshots', () => {
    const a = invoice('A', 101, 200, 25);
    const b = { ...invoice('B', 500), successful: false };
    const c = invoice('C', 199, 100, 75);
    const result = allocateVoucherFunding({ policy, invoices: [a, b, c] });
    expect(result.invoices.map(row => row.invoiceId)).toEqual(['A', 'C']);
    expect(result.invoices.map(row => [row.originalGrossVnd, row.subsidyVnd, row.customerDueVnd]))
      .toEqual([[326, 301, 25], [374, 299, 75]]);
    expect(result.total).toMatchObject({ originalGrossVnd: 700, fixHomeDiscountSubsidyVnd: 600, customerDueVnd: 100 });
    expect(result.invoices[0]).toMatchObject({ originalPlatformDueVnd: a.originalPlatformDueVnd,
      commissionAmountVnd: a.commissionAmountVnd,
      technicianEntitlementVnd: a.technicianEntitlementVnd });
    const free = allocateVoucherFunding({ policy, invoices: [invoice('solo', 200, 300)] });
    expect(free.invoices[0]).toMatchObject({ subsidyVnd: 500, customerDueVnd: 0 });
  });

  it('rounds a capped discount deterministically, independent of input order', () => {
    const fixed = { ...policy, discount: VoucherDiscount.FIXED, value: 2 };
    const a = invoice('A', 1);
    const b = invoice('B', 1);
    const c = invoice('C', 1);
    const first = allocateVoucherFunding({ policy: fixed, invoices: [c, b, a] });
    const second = allocateVoucherFunding({ policy: fixed, invoices: [a, b, c] });
    expect(first.invoices.map(row => [row.invoiceId, row.subsidyVnd])).toEqual([['A', 1], ['B', 1], ['C', 0]]);
    expect(first.invoices).toEqual(second.invoices);
  });

  it('rejects incomplete or inconsistent source facts before any allocation', () => {
    const good = invoice('A', 100, 200);
    expect(() => allocateVoucherFunding({ policy, invoices: [good, { ...good }] })).toThrow();
    expect(() => allocateVoucherFunding({ policy, invoices: [
      { ...good, fixHomePartsTotalVnd: 201 },
    ] })).toThrow();
    expect(() => allocateVoucherFunding({ policy, invoices: [
      { ...good, items: [{ ...good.items[0], invoiceId: 'foreign' }] },
    ] })).toThrow();
  });

  it('reverses one VisitGroup child proportionally and restores quota only after the whole scope is fully refunded', () => {
    const funded = allocateVoucherFunding({ policy, invoices: [invoice('A', 200), invoice('C', 300)] });
    const [a, c] = funded.invoices;
    const reverseA = calculateVoucherRefundDelta(a, 0, a.originalGrossVnd);
    expect(reverseA).toMatchObject({ customerRefundVnd: 0, subsidyReversalVnd: 200 });
    expect(canRestoreVoucherAfterRefund(funded.invoices, { A: 200, C: 0 })).toBe(false);
    expect(canRestoreVoucherAfterRefund(funded.invoices, { A: 200, C: 300 })).toBe(true);
    expect(calculateVoucherRefundDelta(c, c.originalGrossVnd, c.originalGrossVnd))
      .toMatchObject({ customerRefundVnd: 0, subsidyReversalVnd: 0 });
  });

  it('uses cumulative targets so duplicate and split partial refunds cannot over-reverse', () => {
    const funded = allocateVoucherFunding({ policy: { ...policy, value: 50 }, invoices: [invoice('solo', 101, 0, 100)] });
    const row = funded.invoices[0];
    expect(row).toMatchObject({ originalGrossVnd: 201, subsidyVnd: 51, customerDueVnd: 150 });
    const first = calculateVoucherRefundDelta(row, 0, 100);
    const repeat = calculateVoucherRefundDelta(row, 100, 100);
    const second = calculateVoucherRefundDelta(row, 100, 201);
    expect(first.customerRefundVnd + second.customerRefundVnd).toBe(150);
    expect(first.subsidyReversalVnd + second.subsidyReversalVnd).toBe(51);
    expect(repeat).toMatchObject({ customerRefundVnd: 0, subsidyReversalVnd: 0 });
    expect(() => calculateVoucherRefundDelta(row, 100, 99)).toThrow();
    expect(() => calculateVoucherRefundDelta(row, 0, 202)).toThrow();
  });

  it('inverts an approved NET refund only when cumulative gross is unique', () => {
    const row = allocateVoucherFunding({
      policy: { ...policy, value: 10 }, invoices: [invoice('solo', 10)],
    }).invoices[0];
    const first = resolveVoucherRefundFromCustomerNet(row, 0, 1);
    expect(first).toMatchObject({ originalGrossRefundVnd: 1, customerRefundVnd: 1, subsidyReversalVnd: 0 });
    const second = resolveVoucherRefundFromCustomerNet(row, 1, 1);
    expect(second).toMatchObject({ originalGrossRefundVnd: 1, customerRefundVnd: 1, subsidyReversalVnd: 0 });
    expect(() => resolveVoucherRefundFromCustomerNet(row, 1, 10)).toThrow();
  });

  it('rejects NET values with multiple possible gross targets, including fully funded zero due', () => {
    const half = allocateVoucherFunding({
      policy: { ...policy, value: 50 }, invoices: [invoice('half', 10)],
    }).invoices[0];
    expect(() => resolveVoucherRefundFromCustomerNet(half, 0, 1)).toThrow();
    const zero = allocateVoucherFunding({ policy, invoices: [invoice('zero', 10)] }).invoices[0];
    expect(() => resolveVoucherRefundFromCustomerNet(zero, 0, 0)).toThrow();
  });

  it('validates a separately verified gross source against NET, including zero due', () => {
    const half = allocateVoucherFunding({
      policy: { ...policy, value: 50 }, invoices: [invoice('half', 10)],
    }).invoices[0];
    expect(validateVoucherRefundGrossForNet(half, 0, 1, 2))
      .toMatchObject({ originalGrossRefundVnd: 2, customerRefundVnd: 1, subsidyReversalVnd: 1 });
    expect(() => validateVoucherRefundGrossForNet(half, 0, 2, 2)).toThrow();
    const zero = allocateVoucherFunding({ policy, invoices: [invoice('zero', 10)] }).invoices[0];
    expect(validateVoucherRefundGrossForNet(zero, 0, 0, 10))
      .toMatchObject({ originalGrossRefundVnd: 10, customerRefundVnd: 0, subsidyReversalVnd: 10 });
  });
});

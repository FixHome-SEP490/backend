import { describe, expect, it } from 'vitest';
import {
  calculateShippingShares,
  computeInvoiceFinancialComponents,
} from './shipping-finance.policy';

const base = {
  policyVersion: 'W3_70_30_V1' as const,
  shippingFee: 20_000,
  laborTotal: 100_000,
  commissionAmount: 10_000,
  fixHomePartsTotal: 0,
  technicianPartsTotal: 0,
  technicianPartWarrantyFeeTotal: 0,
  knownLaborDeductions: 0,
};

describe('shipping finance integer ledger', () => {
  // Characterize the real invoice policy; these are existing GREEN baselines, not live W3 authorization.
  it.each([
    { shippingFee: 30_000, commissionAmount: 20_000, customer: 21_000, technician: 9_000, gross: 221_000, cashDebit: 50_000, onlineCredit: 171_000 },
    { shippingFee: 30_000, commissionAmount: 0, customer: 21_000, technician: 9_000, gross: 221_000, cashDebit: 30_000, onlineCredit: 191_000 },
    { shippingFee: 0, commissionAmount: 20_000, customer: 0, technician: 0, gross: 200_000, cashDebit: 20_000, onlineCredit: 180_000 },
    { shippingFee: 0, commissionAmount: 0, customer: 0, technician: 0, gross: 200_000, cashDebit: 0, onlineCredit: 200_000 },
  ])('golden 200000 labor: shipping=$shippingFee commission=$commissionAmount', (golden) => {
    const result = computeInvoiceFinancialComponents({
      ...base,
      laborTotal: 200_000,
      shippingFee: golden.shippingFee,
      commissionAmount: golden.commissionAmount,
    });
    expect(result).toEqual({
      customerShippingShare: golden.customer,
      technicianShippingShare: golden.technician,
      grandTotal: golden.gross,
      platformDue: golden.cashDebit,
      netLabor: golden.onlineCredit,
      nonlabor: 0,
      technicianPayout: golden.onlineCredit,
    });
    expect(result.grandTotal - result.platformDue).toBe(golden.onlineCredit);
  });

  it('splits 20000 and reconciles cash, online and custody labor', () => {
    expect(calculateShippingShares(20_000, 'W3_70_30_V1')).toEqual({
      customerShippingShare: 14_000,
      technicianShippingShare: 6_000,
    });
    expect(computeInvoiceFinancialComponents(base)).toMatchObject({
      grandTotal: 114_000,
      platformDue: 30_000,
      netLabor: 84_000,
      nonlabor: 0,
      technicianPayout: 84_000,
    });
  });
  it('preserves explicit legacy 100/0', () => {
    expect(
      computeInvoiceFinancialComponents({
        ...base,
        policyVersion: 'LEGACY_100_0',
      }),
    ).toMatchObject({
      customerShippingShare: 20_000,
      technicianShippingShare: 0,
      grandTotal: 120_000,
      platformDue: 30_000,
      netLabor: 90_000,
      technicianPayout: 90_000,
    });
  });
  it('rounds half up in VND and assigns the exact remainder to the technician', () => {
    for (const [s, c, t] of [
      [0, 0, 0],
      [1, 1, 0],
      [2, 1, 1],
      [5, 4, 1],
      [15, 11, 4],
    ]) {
      expect(calculateShippingShares(s, 'W3_70_30_V1')).toEqual({
        customerShippingShare: c,
        technicianShippingShare: t,
      });
    }
  });
  it('exhaustively preserves conservation and half-up rounding for 0..100000 VND', () => {
    for (let s = 0; s <= 100_000; s++) {
      const r = calculateShippingShares(s, 'W3_70_30_V1');
      if (
        r.customerShippingShare + r.technicianShippingShare !== s ||
        r.customerShippingShare !== Math.floor((s * 7 + 5) / 10)
      )
        throw new Error(`Invalid split ${s}`);
    }
  });
  it.each([
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '20000',
    null,
    undefined,
  ])('rejects invalid shipping %s', (value) => {
    expect(() =>
      calculateShippingShares(value as number, 'W3_70_30_V1'),
    ).toThrow();
  });
  it('does not multiply safe input into unsafe floating point arithmetic', () => {
    expect(
      calculateShippingShares(Number.MAX_SAFE_INTEGER, 'W3_70_30_V1'),
    ).toEqual({
      customerShippingShare: 6_305_039_478_318_694,
      technicianShippingShare: 2_702_159_776_422_297,
    });
  });
  it('rejects unknown or missing policy instead of selecting legacy', () => {
    for (const p of ['70/30', '', null, undefined])
      expect(() => calculateShippingShares(20_000, p as never)).toThrow();
  });
  it('rejects insufficient net labor including other known deductions without clamping', () => {
    expect(() =>
      computeInvoiceFinancialComponents({ ...base, laborTotal: 15_000 }),
    ).toThrow();
    expect(() =>
      computeInvoiceFinancialComponents({
        ...base,
        knownLaborDeductions: 84_001,
      }),
    ).toThrow();
    expect(
      computeInvoiceFinancialComponents({
        ...base,
        knownLaborDeductions: 84_000,
      }).netLabor,
    ).toBe(0);
  });
  it('attributes technician historical parts and warranty entirely to nonlabor', () => {
    const r = computeInvoiceFinancialComponents({
      ...base,
      fixHomePartsTotal: 50_000,
      technicianPartsTotal: 12_000,
      technicianPartWarrantyFeeTotal: 3_000,
      knownLaborDeductions: 1_000,
    });
    expect(r).toMatchObject({
      grandTotal: 179_000,
      platformDue: 80_000,
      netLabor: 83_000,
      nonlabor: 15_000,
      technicianPayout: 98_000,
    });
    expect(r.grandTotal - r.platformDue - 1_000).toBe(r.technicianPayout);
  });
  it('rejects fractional, negative and overflowing monetary components', () => {
    for (const key of [
      'laborTotal',
      'commissionAmount',
      'fixHomePartsTotal',
      'technicianPartsTotal',
      'technicianPartWarrantyFeeTotal',
      'knownLaborDeductions',
    ]) {
      for (const value of [-1, 0.5, Infinity, NaN, undefined]) {
        expect(() =>
          computeInvoiceFinancialComponents({ ...base, [key]: value }),
        ).toThrow();
      }
    }
    expect(() =>
      computeInvoiceFinancialComponents({
        ...base,
        laborTotal: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow();
  });
  it('rounds each child before group aggregation, including mixed historical policy', () => {
    const child = computeInvoiceFinancialComponents({
      ...base,
      shippingFee: 1,
    });
    expect(child.customerShippingShare * 2).toBe(2);
    expect(child.technicianShippingShare * 2).toBe(0);
    const a = computeInvoiceFinancialComponents(base);
    const b = computeInvoiceFinancialComponents({
      ...base,
      policyVersion: 'LEGACY_100_0',
    });
    expect(a.grandTotal + b.grandTotal).toBe(234_000);
    expect(a.technicianPayout + b.technicianPayout).toBe(174_000);
  });
  it('keeps voucher credit separate from gross and technician labor', () => {
    const r = computeInvoiceFinancialComponents(base);
    const credit = 10_000;
    const customerNet = r.grandTotal - credit;
    expect(customerNet).toBe(104_000);
    expect(customerNet + credit - r.platformDue).toBe(r.technicianPayout);
    expect(r.netLabor).toBe(84_000);
  });
  it('handles zero fee pickup arithmetic without a split deduction', () => {
    expect(
      computeInvoiceFinancialComponents({ ...base, shippingFee: 0 }),
    ).toMatchObject({ grandTotal: 100_000, netLabor: 90_000 });
  });
});

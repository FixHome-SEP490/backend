import { describe, expect, it } from 'vitest';
import { readInvoiceFinancialSnapshot } from './invoice-financial-snapshot';

const w3 = {
  shippingPolicyVersion: 'W3_70_30_V1',
  shippingFee: 20_000,
  customerShippingShare: 14_000,
  technicianShippingShare: 6_000,
  laborTotal: 100_000,
  commissionAmount: 10_000,
  partsTotal: 62_000,
  fixHomePartsTotal: 50_000,
  technicianPartsTotal: 12_000,
  technicianPartWarrantyFeeTotal: 3_000,
  grandTotal: 179_000,
};

describe('frozen invoice financial components before other labor deductions', () => {
  it('keeps full courier cost in dues and reduces custody labor, not nonlabor', () => {
    expect(readInvoiceFinancialSnapshot(w3)).toMatchObject({
      grandTotal: 179_000,
      platformDue: 80_000,
      netLabor: 84_000,
      nonlabor: 15_000,
      technicianPayout: 99_000,
    });
  });

  it.each([
    [1, 1, 0, 165_001, 60_001, 90_000, 105_000],
    [5, 4, 1, 165_004, 60_005, 89_999, 104_999],
  ])(
    'uses the approved shares for S=%i',
    (s, c, t, gross, due, labor, payout) => {
      expect(
        readInvoiceFinancialSnapshot({
          ...w3,
          shippingFee: s,
          customerShippingShare: c,
          technicianShippingShare: t,
          grandTotal: gross,
        }),
      ).toMatchObject({
        grandTotal: gross,
        platformDue: due,
        netLabor: labor,
        nonlabor: 15_000,
        technicianPayout: payout,
      });
    },
  );

  it('preserves historical legacy 100/0 including bigint driver strings', () => {
    expect(
      readInvoiceFinancialSnapshot({
        ...w3,
        shippingPolicyVersion: 'LEGACY_100_0',
        shippingFee: '20000',
        customerShippingShare: null,
        technicianShippingShare: null,
        grandTotal: '185000',
      }),
    ).toMatchObject({
      grandTotal: 185_000,
      platformDue: 80_000,
      netLabor: 90_000,
      nonlabor: 15_000,
      technicianPayout: 105_000,
    });
  });

  it('does not rewrite a historical invoice or freeze caller data', () => {
    const invoice = structuredClone(w3);
    const before = structuredClone(invoice);
    const facts = readInvoiceFinancialSnapshot(invoice);
    expect(invoice).toEqual(before);
    expect(Object.isFrozen(invoice)).toBe(false);
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('sums rounded shipments without rounding the invoice total again', () => {
    const shipment = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 1,
      customerShippingShare: 1,
      technicianShippingShare: 0,
    };
    const invoice = {
      ...w3,
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
      grandTotal: 165_002,
    };
    expect(
      readInvoiceFinancialSnapshot(invoice, [shipment, { ...shipment }]),
    ).toMatchObject({
      platformDue: 60_002,
      netLabor: 90_000,
      nonlabor: 15_000,
      technicianPayout: 105_000,
    });
    // Aggregate shares alone do not prove per-shipment rounding.
    expect(() => readInvoiceFinancialSnapshot(invoice)).toThrow();
  });

  it('rejects mismatched, missing, empty or mixed-policy shipment evidence', () => {
    const shipment = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 20_000,
      customerShippingShare: 14_000,
      technicianShippingShare: 6_000,
    };
    for (const shipments of [
      [],
      [null],
      [{}],
      [shipment, shipment],
      [{ ...shipment, technicianShippingShare: null }],
      [{ shippingPolicyVersion: 'LEGACY_100_0', shippingFee: 20_000 }],
    ]) {
      expect(() =>
        readInvoiceFinancialSnapshot(w3, shipments as never),
      ).toThrow();
    }
  });

  it('rejects aggregate technician shipping above the remaining labor budget', () => {
    const shipment = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 5,
      customerShippingShare: 4,
      technicianShippingShare: 1,
    };
    expect(() =>
      readInvoiceFinancialSnapshot(
        {
          ...w3,
          laborTotal: 10_001,
          shippingFee: 10,
          customerShippingShare: 8,
          technicianShippingShare: 2,
          grandTotal: 75_009,
        },
        [shipment, { ...shipment }],
      ),
    ).toThrow();
  });

  it('does not accept a total-level split that conflicts with the shipment snapshots', () => {
    const shipment = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 1,
      customerShippingShare: 1,
      technicianShippingShare: 0,
    };
    expect(() =>
      readInvoiceFinancialSnapshot(
        {
          ...w3,
          shippingFee: 2,
          customerShippingShare: 1,
          technicianShippingShare: 1,
          grandTotal: 165_001,
        },
        [shipment, { ...shipment }],
      ),
    ).toThrow();
  });

  it('accepts the exact safe VND limit but rejects overflowing shipment totals', () => {
    expect(
      readInvoiceFinancialSnapshot({
        ...w3,
        shippingPolicyVersion: 'LEGACY_100_0',
        shippingFee: 1,
        customerShippingShare: 1,
        technicianShippingShare: 0,
        laborTotal: Number.MAX_SAFE_INTEGER - 1,
        commissionAmount: 0,
        partsTotal: 0,
        fixHomePartsTotal: 0,
        technicianPartsTotal: 0,
        technicianPartWarrantyFeeTotal: 0,
        grandTotal: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      platformDue: 1,
      technicianPayout: Number.MAX_SAFE_INTEGER - 1,
    });
    const huge = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: Number.MAX_SAFE_INTEGER,
      customerShippingShare: 6_305_039_478_318_694,
      technicianShippingShare: 2_702_159_776_422_297,
    };
    expect(() => readInvoiceFinancialSnapshot(w3, [huge, huge])).toThrow();
  });

  it('rejects a negative labor budget even when technician parts could hide it', () => {
    expect(() =>
      readInvoiceFinancialSnapshot({
        ...w3,
        laborTotal: 15_000,
        commissionAmount: 10_000,
        grandTotal: 94_000,
      }),
    ).toThrow();
    expect(
      readInvoiceFinancialSnapshot({
        ...w3,
        laborTotal: 16_000,
        commissionAmount: 10_000,
        grandTotal: 95_000,
      }),
    ).toMatchObject({
      netLabor: 0,
      nonlabor: 15_000,
      technicianPayout: 15_000,
    });
  });

  it('rejects full-S customer gross on a W3 invoice', () => {
    expect(() =>
      readInvoiceFinancialSnapshot({ ...w3, grandTotal: 185_000 }),
    ).toThrow();
  });

  it.each([
    { shippingFee: undefined },
    { customerShippingShare: null },
    { technicianShippingShare: null },
    { shippingPolicyVersion: null },
    { shippingPolicyVersion: 'unknown' },
    { shippingFee: 20_001 },
    { partsTotal: 61_999 },
    { grandTotal: null },
    { laborTotal: undefined },
    { commissionAmount: false },
    { technicianPartsTotal: ' 12000' },
    { technicianPartWarrantyFeeTotal: '3000.00' },
    { fixHomePartsTotal: '' },
    { commissionAmount: -1 },
    { laborTotal: 0.5 },
    { partsTotal: Infinity },
    { grandTotal: Number.MAX_SAFE_INTEGER + 1 },
  ])('fails closed on malformed financial snapshot %j', (overrides) => {
    expect(() =>
      readInvoiceFinancialSnapshot({ ...w3, ...overrides }),
    ).toThrow();
  });

  it('rejects overflowing monetary sums even when Number arithmetic rounds them equal', () => {
    expect(() =>
      readInvoiceFinancialSnapshot({
        ...w3,
        shippingPolicyVersion: 'LEGACY_100_0',
        shippingFee: 1,
        customerShippingShare: 1,
        technicianShippingShare: 0,
        laborTotal: Number.MAX_SAFE_INTEGER,
        commissionAmount: 0,
        partsTotal: 1,
        fixHomePartsTotal: 1,
        technicianPartsTotal: 0,
        technicianPartWarrantyFeeTotal: 0,
        grandTotal: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow();
  });
});

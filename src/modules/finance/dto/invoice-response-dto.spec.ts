// Tests for toInvoiceResponse W3 shipping snapshot exposure (read-only, frozen, backward-compat).
// Task: expose FROZEN W3 invoice 70/30 shipping snapshot on existing authenticated GET invoice responses.
import { describe, expect, it } from 'vitest';
import { toInvoiceResponse } from './finance.dto';
import { Invoice } from '../../service-orders/entities/invoice.entity';
import { PaymentStatus } from '../../../shared/enums';

/** Minimal invoice fixture builder */
function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    serviceOrderId: 'order-1',
    laborTotal: 200_000,
    partsTotal: 0,
    fixHomePartsTotal: 0,
    technicianPartsTotal: 0,
    technicianPartWarrantyFeeTotal: 0,
    shippingFee: 30_000,
    shippingPolicyVersion: 'W3_70_30_V1',
    customerShippingShare: 21_000,
    technicianShippingShare: 9_000,
    shippingShipments: null,
    grandTotal: 221_000,
    commissionBase: 'LABOR',
    commissionRateSnapshot: 0.1,
    commissionAmount: 20_000,
    paymentStatus: PaymentStatus.UNPAID,
    issuedAt: new Date('2026-11-07T00:00:00Z'),
    paidAt: null,
    items: [],
    ...overrides,
  } as unknown as Invoice;
}

describe('toInvoiceResponse — W3 shipping snapshot exposure', () => {
  it('golden W3: L200000 C20000 S30000 → customer gross 221000, shares 21000/9000', () => {
    const invoice = makeInvoice();
    const dto = toInvoiceResponse(invoice);

    expect(dto.grandTotal).toBe(221_000);
    expect(dto.shippingFee).toBe(30_000);
    expect(dto.shippingPolicyVersion).toBe('W3_70_30_V1');
    expect(dto.customerShippingShare).toBe(21_000);
    expect(dto.technicianShippingShare).toBe(9_000);
    expect(dto.commissionAmount).toBe(20_000);
    expect(dto.laborTotal).toBe(200_000);
  });

  it('two 1-VND shipments: customer 2 (1+1), technician 0 (0+0)', () => {
    const shipment = {
      partRequestId: 'pr-a',
      additionalCostId: 'ac-a',
      termsVersion: 1,
      receiptVersion: 1,
      shippingPolicyVersion: 'W3_70_30_V1' as const,
      shippingFee: 1,
      customerShippingShare: 1,
      technicianShippingShare: 0,
    };
    const invoice = makeInvoice({
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
      grandTotal: 200_002,
      shippingShipments: [
        shipment,
        { ...shipment, partRequestId: 'pr-b', additionalCostId: 'ac-b' },
      ],
    });

    const dto = toInvoiceResponse(invoice);

    expect(dto.shippingFee).toBe(2);
    expect(dto.shippingPolicyVersion).toBe('W3_70_30_V1');
    expect(dto.customerShippingShare).toBe(2);
    expect(dto.technicianShippingShare).toBe(0);
    expect(dto.shippingShipments).toHaveLength(2);
    expect(dto.shippingShipments![0].customerShippingShare).toBe(1);
    expect(dto.shippingShipments![0].technicianShippingShare).toBe(0);
    expect(dto.shippingShipments![1].customerShippingShare).toBe(1);
    expect(dto.shippingShipments![1].technicianShippingShare).toBe(0);
  });

  it('paid invoice is not repriced — amounts unchanged after payment', () => {
    const invoice = makeInvoice({
      paymentStatus: PaymentStatus.PAID,
      paidAt: new Date('2026-11-07T01:00:00Z'),
    });

    const before = {
      grandTotal: invoice.grandTotal,
      customerShippingShare: Number(invoice.customerShippingShare),
      technicianShippingShare: Number(invoice.technicianShippingShare),
    };

    const dto = toInvoiceResponse(invoice);

    expect(dto.paymentStatus).toBe(PaymentStatus.PAID);
    expect(dto.grandTotal).toBe(before.grandTotal);
    expect(dto.customerShippingShare).toBe(before.customerShippingShare);
    expect(dto.technicianShippingShare).toBe(before.technicianShippingShare);
    expect(dto.paidAt).toBeInstanceOf(Date);
  });

  it('legacy (LEGACY_100_0) with null shares → customer gets full S, technician 0', () => {
    const invoice = makeInvoice({
      shippingPolicyVersion: 'LEGACY_100_0',
      shippingFee: 30_000,
      customerShippingShare: null,
      technicianShippingShare: null,
      grandTotal: 230_000,
    });

    const dto = toInvoiceResponse(invoice);

    expect(dto.shippingPolicyVersion).toBe('LEGACY_100_0');
    // Legacy behavior: customer bears the full shipping cost
    expect(dto.customerShippingShare).toBe(30_000);
    expect(dto.technicianShippingShare).toBe(0);
    expect(dto.shippingShipments).toBeNull();
  });

  it('legacy with no shippingPolicyVersion set (historical rows) → treated as LEGACY_100_0', () => {
    const invoice = makeInvoice({
      shippingPolicyVersion: undefined as any,
      shippingFee: 20_000,
      customerShippingShare: null,
      technicianShippingShare: null,
    });

    const dto = toInvoiceResponse(invoice);

    expect(dto.shippingPolicyVersion).toBe('LEGACY_100_0');
    expect(dto.customerShippingShare).toBe(20_000);
    expect(dto.technicianShippingShare).toBe(0);
  });

  it('W3 with explicit shares present — passes through without recalculation', () => {
    const invoice = makeInvoice({
      shippingFee: 10_000,
      customerShippingShare: 7_000,
      technicianShippingShare: 3_000,
      grandTotal: 207_000,
    });

    const dto = toInvoiceResponse(invoice);

    // Must use frozen snapshot, not 70% of 10_000
    expect(dto.customerShippingShare).toBe(7_000);
    expect(dto.technicianShippingShare).toBe(3_000);
  });

  it('shippingShipments null when no W3 shipments recorded', () => {
    const dto = toInvoiceResponse(makeInvoice({ shippingShipments: null }));
    expect(dto.shippingShipments).toBeNull();
  });

  it('toInvoiceResponse does not mutate the original invoice entity', () => {
    const invoice = makeInvoice();
    const original = { ...invoice };
    toInvoiceResponse(invoice);
    expect(invoice).toEqual(original);
  });
});

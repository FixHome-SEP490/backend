import { describe, expect, it } from 'vitest';
import {
  assertShippingFinancialCutoverAllowed,
  readInvoiceShippingSnapshot,
} from './invoice-shipping-snapshot';
import { assessOrderShippingLaborBudget } from './order-shipping-labor-budget.policy';

describe('immutable shipping snapshot readers and closed cutover', () => {
  it('golden two 1-VND shipments on ONE order sum rounded shares before reading the invoice', () => {
    const shipments = ['delivery-a', 'delivery-b'].map((partRequestId) => ({
      serviceOrderId: 'order-1',
      partRequestId,
      quoteVersion: 1,
      shippingPolicyVersion: 'W3_70_30_V1' as const,
      shippingFee: 1,
      customerShippingShare: 1,
      technicianShippingShare: 0,
    }));
    const aggregate = assessOrderShippingLaborBudget({
      version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1',
      serviceOrderId: 'order-1',
      laborTotal: 200_000,
      commissionAmount: 20_000,
      knownApprovedDeductions: 0,
      deliveryRequestIds: ['delivery-a', 'delivery-b'],
      deliveries: shipments,
    });
    expect(aggregate).toMatchObject({
      deliveryCount: 2,
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
      netLaborAfterShipping: 180_000,
      financialExecution: 'BLOCKED',
    });
    const invoice = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
    };
    expect(readInvoiceShippingSnapshot(invoice, shipments)).toEqual({
      policyVersion: 'W3_70_30_V1',
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
    });
    // Without shipment provenance the current reader splits aggregate S=2 as 1/1 and refuses 2/0.
    expect(() => readInvoiceShippingSnapshot(invoice)).toThrow();
    expect(() => assertShippingFinancialCutoverAllowed(invoice)).toThrow();
  });

  it('reads historical absent shares as legacy without mutating the invoice', () => {
    const invoice = Object.freeze({ shippingFee: '20000' });
    expect(readInvoiceShippingSnapshot(invoice)).toEqual({
      policyVersion: 'LEGACY_100_0',
      shippingFee: 20000,
      customerShippingShare: 20000,
      technicianShippingShare: 0,
    });
    expect(invoice).toEqual({ shippingFee: '20000' });
    expect(() => assertShippingFinancialCutoverAllowed(invoice)).not.toThrow();
  });
  it('accepts explicit legacy snapshot using bigint driver strings', () => {
    expect(() =>
      assertShippingFinancialCutoverAllowed({
        shippingPolicyVersion: 'LEGACY_100_0',
        shippingFee: '20000',
        customerShippingShare: '20000',
        technicianShippingShare: '0',
      }),
    ).not.toThrow();
  });
  it('can validate new-policy arithmetic but never authorize a live W3 financial action', () => {
    const invoice = {
      shippingPolicyVersion: 'W3_70_30_V1',
      shippingFee: 20000,
      customerShippingShare: 14000,
      technicianShippingShare: 6000,
    };
    expect(readInvoiceShippingSnapshot(invoice)).toMatchObject({
      policyVersion: 'W3_70_30_V1',
      technicianShippingShare: 6000,
    });
    expect(() => assertShippingFinancialCutoverAllowed(invoice)).toThrow(
      'Chính sách giao linh kiện chưa được mở thanh toán.',
    );
  });
  it.each([
    { shippingPolicyVersion: 'unknown' },
    { shippingPolicyVersion: null },
    { shippingPolicyVersion: 'W3_70_30_V1' },
    { customerShippingShare: 14000, technicianShippingShare: 6000 },
    {
      shippingPolicyVersion: 'LEGACY_100_0',
      customerShippingShare: 14000,
      technicianShippingShare: 6000,
    },
    { shippingPolicyVersion: 'LEGACY_100_0', customerShippingShare: 20000 },
    {
      shippingPolicyVersion: 'W3_70_30_V1',
      customerShippingShare: 14001,
      technicianShippingShare: 5999,
    },
    {
      shippingPolicyVersion: 'W3_70_30_V1',
      customerShippingShare: 14000,
      technicianShippingShare: 5999,
    },
    { shippingFee: '20000.00' },
    { shippingFee: ' 20000' },
    { shippingFee: null },
    { shippingFee: true },
    { shippingFee: '' },
    { shippingFee: -1 },
  ])('fails closed on malformed/conflicting snapshot %j', (overrides) => {
    expect(() =>
      readInvoiceShippingSnapshot({ shippingFee: 20000, ...overrides }),
    ).toThrow();
  });
});

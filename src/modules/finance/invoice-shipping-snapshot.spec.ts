import { describe, expect, it } from 'vitest';
import {
  assertShippingFinancialCutoverAllowed,
  readInvoiceShippingSnapshot,
} from './invoice-shipping-snapshot';

describe('immutable shipping snapshot readers and closed cutover', () => {
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

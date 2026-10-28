import { describe, expect, it } from 'vitest';
import { assertCashReceiptMatchesIntent } from './cash-intent-policy';

const intent = {
  customerId: 'customer-1', technicianId: 'tech-1', status: 'pending' as const,
  grossVnd: 150_000, customerDueVnd: 120_000,
  allocations: [{ invoiceId: 'invoice-1', serviceOrderId: 'order-1', originalGrossVnd: 150_000, customerDueVnd: 120_000 }],
};

describe('cash intent receipt authority', () => {
  it('accepts only the owner-selected NET amount and unchanged frozen invoice', () => {
    expect(() => assertCashReceiptMatchesIntent(intent, 'tech-1', 120_000, intent.allocations)).not.toThrow();
    expect(() => assertCashReceiptMatchesIntent(intent, 'tech-2', 120_000, intent.allocations)).toThrow();
    expect(() => assertCashReceiptMatchesIntent(intent, 'tech-1', 150_000, intent.allocations)).toThrow();
    expect(() => assertCashReceiptMatchesIntent(intent, 'tech-1', 120_000,
      [{ ...intent.allocations[0], originalGrossVnd: 150_001 }])).toThrow();
  });

  it('never treats a cancelled or received intent as a new receipt', () => {
    for (const status of ['cancelled', 'received']) {
      expect(() => assertCashReceiptMatchesIntent({ ...intent, status }, 'tech-1', 120_000, intent.allocations)).toThrow();
    }
  });

  it('requires every funded VisitGroup child and its NET allocation to remain unchanged', () => {
    const group = { customerId: 'customer-1', technicianId: 'tech-1', status: 'pending',
      grossVnd: 200_000, customerDueVnd: 150_000,
      allocations: [
        { invoiceId: 'invoice-1', serviceOrderId: 'order-1', originalGrossVnd: 100_000, customerDueVnd: 75_000 },
        { invoiceId: 'invoice-2', serviceOrderId: 'order-2', originalGrossVnd: 100_000, customerDueVnd: 75_000 },
      ] };
    expect(() => assertCashReceiptMatchesIntent(group, 'tech-1', 150_000, [...group.allocations].reverse())).not.toThrow();
    expect(() => assertCashReceiptMatchesIntent(group, 'tech-1', 150_000,
      [group.allocations[0], { ...group.allocations[1], customerDueVnd: 76_000 }])).toThrow();
    expect(() => assertCashReceiptMatchesIntent(group, 'tech-1', 150_000,
      [group.allocations[0]])).toThrow();
  });

  it('fails closed on malformed stored allocation evidence', () => {
    expect(() => assertCashReceiptMatchesIntent({ ...intent, allocations: [null] as any },
      'tech-1', 120_000, intent.allocations)).toThrow();
    expect(() => assertCashReceiptMatchesIntent({ ...intent, allocations: null as any },
      'tech-1', 120_000, intent.allocations)).toThrow();
  });
});

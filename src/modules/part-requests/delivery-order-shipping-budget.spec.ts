import { describe, expect, it } from 'vitest';
import { Role } from '../../shared/enums';
import {
  applyDeliveryCommand,
  assessDeliveryOrderShippingLaborBudget,
  createDeliveryProposal,
} from './delivery-consent.policy';

const budget = {
  laborTotal: 20_000,
  commissionAmount: 2_000,
  knownApprovedDeductions: 1_000,
};
const sm = { id: 'manager-1', role: Role.SERVICE_MANAGER };
const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const proposal = (overrides = {}) => ({
  kind: 'PROPOSE' as const,
  commandId: key(1),
  expectedVersion: 0,
  totalShippingFee: 20_000,
  budget: { ...budget },
  evidenceRef: 'quote-evidence',
  approvedCostRef: 'approved-cost',
  ...overrides,
});
const make = (id: string, overrides = {}) =>
  createDeliveryProposal(
    {
      partRequestId: id,
      serviceOrderId: 'order-1',
      customerId: 'customer-1',
      technicianId: 'technician-1',
      responsibleServiceManagerId: sm.id,
    },
    proposal(overrides),
    sm,
  );
const assess = (states: ReturnType<typeof make>[], overrides = {}) =>
  assessDeliveryOrderShippingLaborBudget(
    'order-1',
    { ...budget, ...overrides },
    ['a', 'b'],
    states,
  );

describe('delivery consent heads to shared order budget, preparatory only', () => {
  it('rejects two individually valid consent proposals that jointly exceed the order labor', () => {
    const a = make('a', { budget: { ...budget, laborTotal: 12_000 } });
    const b = make('b', { budget: { ...budget, laborTotal: 12_000 } });
    expect(a.quote.netLaborAfterShipping).toBe(3_000);
    expect(b.quote.netLaborAfterShipping).toBe(3_000);
    expect(() => assess([a, b], { laborTotal: 12_000 })).toThrow(
      'ORDER_SHIPPING_INSUFFICIENT_NET_LABOR',
    );
  });

  it('counts exact proposal retries once in the supplied canonical head set', () => {
    const a = make('a');
    const retry = applyDeliveryCommand(a, proposal(), sm);
    expect(retry.receipts).toHaveLength(1);
    expect(assess([retry, make('b')])).toMatchObject({
      deliveryCount: 2,
      technicianShippingShare: 12_000,
      netLaborAfterShipping: 5_000,
      financialExecution: 'BLOCKED',
    });
    expect(() => assess([a, retry, make('b')])).toThrow(
      'ORDER_SHIPPING_DUPLICATE_DELIVERY',
    );
  });

  it('uses an explicit revised head but never guesses between historical versions', () => {
    const a = make('a');
    const revised = applyDeliveryCommand(
      a,
      {
        ...proposal(),
        kind: 'REVISE',
        commandId: key(2),
        expectedVersion: 1,
        totalShippingFee: 30_000,
        evidenceRef: 'new-quote-evidence',
      },
      sm,
    );
    expect(assess([revised, make('b')])).toMatchObject({
      technicianShippingShare: 15_000,
      netLaborAfterShipping: 2_000,
    });
    expect(() => assess([a, revised, make('b')])).toThrow(
      'ORDER_SHIPPING_DUPLICATE_DELIVERY',
    );
    expect(assess([a, make('b')]).netLaborAfterShipping).toBe(5_000);
  });

  it('keeps the ceiling commitment after a lower actual without a financial release ledger', () => {
    let a = make('a');
    for (const [i, role, id] of [
      [2, Role.CUSTOMER, 'customer-1'],
      [3, Role.TECHNICIAN, 'technician-1'],
    ] as const)
      a = applyDeliveryCommand(
        a,
        {
          kind: 'CONSENT',
          commandId: key(i),
          expectedVersion: a.version,
          quoteVersion: 1,
          quoteFingerprint: a.quote.fingerprint,
          totalShippingFee: 20_000,
          shippingShare: role === Role.CUSTOMER ? 14_000 : 6_000,
          accepted: true,
          evidenceRef: `consent-${i}`,
        },
        { id, role },
      );
    a = applyDeliveryCommand(
      a,
      {
        kind: 'RECORD_ACTUAL',
        commandId: key(4),
        expectedVersion: a.version,
        quoteVersion: 1,
        totalShippingFee: 0,
        evidenceRef: 'lower-actual',
      },
      sm,
    );
    expect(a.actual?.technicianShippingShare).toBe(0);
    expect(assess([a, make('b')]).technicianShippingShare).toBe(12_000);
  });

  it('rejects missing sibling, forged share, foreign order and physical release shortcuts', () => {
    const a = make('a'),
      b = make('b');
    expect(() => assess([a])).toThrow('ORDER_SHIPPING_COVERAGE_REQUIRED');
    const forged = structuredClone(b);
    (forged.quote as any).technicianShippingShare = 0;
    expect(() => assess([a, forged])).toThrow('DELIVERY_INVALID_STATE');
    expect(() => assess([a, { ...b, status: 'RELEASED' } as never])).toThrow(
      'DELIVERY_INVALID_STATE',
    );
    const foreign = createDeliveryProposal(
      { ...b.scope, serviceOrderId: 'order-2' },
      proposal(),
      sm,
    );
    expect(() => assess([a, foreign])).toThrow(
      'ORDER_SHIPPING_SCOPE_OR_COVERAGE_MISMATCH',
    );
  });

  it('preserves zero-fee arithmetic and closed financial execution', () => {
    expect(
      assess([
        make('a', { totalShippingFee: 0 }),
        make('b', { totalShippingFee: 0 }),
      ]),
    ).toMatchObject({
      technicianShippingShare: 0,
      netLaborAfterShipping: 17_000,
      financialExecution: 'BLOCKED',
    });
  });
});

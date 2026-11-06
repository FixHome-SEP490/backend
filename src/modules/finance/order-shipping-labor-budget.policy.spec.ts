import { describe, expect, it } from 'vitest';
import {
  assessOrderShippingLaborBudget,
  OrderShippingLaborBudgetInput,
} from './order-shipping-labor-budget.policy';

const delivery = (partRequestId = 'delivery-a', overrides = {}) => ({
  serviceOrderId: 'order-1',
  partRequestId,
  quoteVersion: 1,
  shippingPolicyVersion: 'W3_70_30_V1' as const,
  shippingFee: 20_000,
  customerShippingShare: 14_000,
  technicianShippingShare: 6_000,
  ...overrides,
});
const input = (overrides = {}): OrderShippingLaborBudgetInput => ({
  version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1',
  serviceOrderId: 'order-1',
  laborTotal: 20_000,
  commissionAmount: 2_000,
  knownApprovedDeductions: 1_000,
  deliveryRequestIds: ['delivery-a', 'delivery-b'],
  deliveries: [delivery(), delivery('delivery-b')],
  ...overrides,
});

describe('W3 order shipping labor budget arithmetic, never financial authority', () => {
  it('rejects inherited, accessor or symbol authority without invoking getters', () => {
    let invoked = false;
    const accessor = input();
    Object.defineProperty(accessor, 'laborTotal', {
      get: () => {
        invoked = true;
        return 20_000;
      },
    });
    for (const candidate of [
      accessor,
      Object.assign(Object.create({ released: true }), input()),
      { ...input(), [Symbol('verified')]: true },
    ])
      expect(() => assessOrderShippingLaborBudget(candidate)).toThrow(
        'ORDER_SHIPPING_INVALID_SHAPE',
      );
    expect(invoked).toBe(false);
  });

  it('preserves exact safe-integer arithmetic and is independent of row order', () => {
    expect(
      assessOrderShippingLaborBudget(
        input({
          laborTotal: Number.MAX_SAFE_INTEGER,
          commissionAmount: 0,
          knownApprovedDeductions: 0,
          deliveryRequestIds: ['delivery-a'],
          deliveries: [
            delivery('delivery-a', {
              shippingFee: Number.MAX_SAFE_INTEGER,
              customerShippingShare: 6_305_039_478_318_694,
              technicianShippingShare: 2_702_159_776_422_297,
            }),
          ],
        }),
      ),
    ).toMatchObject({ netLaborAfterShipping: 6_305_039_478_318_694 });
    expect(
      assessOrderShippingLaborBudget(
        input({ deliveries: [delivery('delivery-b'), delivery()] }),
      ),
    ).toEqual(assessOrderShippingLaborBudget(input()));
  });

  it('sums explicit shipment shares against one shared L-C-D budget', () => {
    const result = assessOrderShippingLaborBudget(input());
    expect(result).toEqual({
      version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1',
      serviceOrderId: 'order-1',
      deliveryCount: 2,
      shippingFee: 40_000,
      customerShippingShare: 28_000,
      technicianShippingShare: 12_000,
      netLaborAfterShipping: 5_000,
      financialExecution: 'BLOCKED',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects two individually affordable deliveries whose sum exceeds the order budget', () => {
    for (const id of ['delivery-a', 'delivery-b'])
      expect(
        assessOrderShippingLaborBudget(
          input({
            laborTotal: 12_000,
            deliveryRequestIds: [id],
            deliveries: [delivery(id)],
          }),
        ).netLaborAfterShipping,
      ).toBe(3_000);
    expect(() =>
      assessOrderShippingLaborBudget(input({ laborTotal: 12_000 })),
    ).toThrow('ORDER_SHIPPING_INSUFFICIENT_NET_LABOR');
    expect(
      assessOrderShippingLaborBudget(input({ laborTotal: 15_000 }))
        .netLaborAfterShipping,
    ).toBe(0);
  });

  it('preserves per-shipment 1+1 rounding instead of splitting total 2', () => {
    expect(
      assessOrderShippingLaborBudget(
        input({
          laborTotal: 0,
          commissionAmount: 0,
          knownApprovedDeductions: 0,
          deliveries: ['delivery-a', 'delivery-b'].map((id) =>
            delivery(id, {
              shippingFee: 1,
              customerShippingShare: 1,
              technicianShippingShare: 0,
            }),
          ),
        }),
      ),
    ).toMatchObject({
      shippingFee: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
      netLaborAfterShipping: 0,
      financialExecution: 'BLOCKED',
    });
  });

  it('does not treat a missing or unknown sibling as free', () => {
    for (const overrides of [
      { deliveries: [delivery()] },
      { deliveries: undefined },
      { deliveryRequestIds: undefined },
      { deliveries: [delivery(), delivery('unexpected')] },
      {
        deliveries: [
          delivery(),
          delivery('delivery-b', { technicianShippingShare: undefined }),
        ],
      },
    ])
      expect(() => assessOrderShippingLaborBudget(input(overrides))).toThrow(
        'ORDER_SHIPPING_',
      );
  });

  it('rejects duplicate heads, replays and mixed quote versions instead of selecting one', () => {
    for (const second of [
      delivery(),
      delivery('delivery-a', { quoteVersion: 2 }),
    ])
      expect(() =>
        assessOrderShippingLaborBudget(
          input({
            deliveryRequestIds: ['delivery-a'],
            deliveries: [delivery(), second],
          }),
        ),
      ).toThrow('ORDER_SHIPPING_DUPLICATE_DELIVERY');
    expect(() =>
      assessOrderShippingLaborBudget(
        input({
          deliveryRequestIds: ['delivery-a', 'delivery-a'],
        }),
      ),
    ).toThrow('ORDER_SHIPPING_DUPLICATE_DELIVERY');
    const original = input();
    expect(assessOrderShippingLaborBudget(original)).toEqual(
      assessOrderShippingLaborBudget(structuredClone(original)),
    );
  });

  it('accepts an explicit replacement head once without mutating the old quote', () => {
    const old = input();
    const revised = input({
      deliveries: [
        delivery('delivery-a', {
          quoteVersion: 2,
          shippingFee: 30_000,
          customerShippingShare: 21_000,
          technicianShippingShare: 9_000,
        }),
        delivery('delivery-b'),
      ],
    });
    expect(assessOrderShippingLaborBudget(revised).netLaborAfterShipping).toBe(
      2_000,
    );
    expect(assessOrderShippingLaborBudget(old).netLaborAfterShipping).toBe(
      5_000,
    );
    expect(Object.isFrozen(old)).toBe(false);
    expect(Object.isFrozen(old.deliveries)).toBe(false);
  });

  it('rejects foreign order or legacy policy rather than reinterpreting historical costs', () => {
    for (const overrides of [
      { serviceOrderId: 'other-order' },
      { shippingPolicyVersion: 'LEGACY_100_0' },
      { customerShippingShare: 13_999, technicianShippingShare: 6_001 },
      { quoteVersion: 0 },
    ])
      expect(() =>
        assessOrderShippingLaborBudget(
          input({
            deliveries: [delivery(), delivery('delivery-b', overrides)],
          }),
        ),
      ).toThrow('ORDER_SHIPPING_');
  });

  it('does not infer financial release from physical status or accept a release flag', () => {
    expect(() =>
      assessOrderShippingLaborBudget(
        input({
          deliveries: [
            delivery(),
            delivery('delivery-b', { status: 'RELEASED' }),
          ],
        }),
      ),
    ).toThrow('ORDER_SHIPPING_INVALID_SHAPE');
    expect(() =>
      assessOrderShippingLaborBudget(input({ released: true })),
    ).toThrow('ORDER_SHIPPING_INVALID_SHAPE');
  });

  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    null,
    undefined,
  ])('rejects non-whole or missing money %s', (value) => {
    for (const field of [
      'laborTotal',
      'commissionAmount',
      'knownApprovedDeductions',
    ])
      expect(() =>
        assessOrderShippingLaborBudget(input({ [field]: value })),
      ).toThrow('ORDER_SHIPPING_INVALID_VND');
    for (const field of [
      'shippingFee',
      'customerShippingShare',
      'technicianShippingShare',
    ])
      expect(() =>
        assessOrderShippingLaborBudget(
          input({
            deliveries: [
              delivery('delivery-a', { [field]: value }),
              delivery('delivery-b'),
            ],
          }),
        ),
      ).toThrow('ORDER_SHIPPING_INVALID_VND');
  });

  it('checks aggregate overflow and negative L-C-D even with no shipping', () => {
    expect(() =>
      assessOrderShippingLaborBudget(
        input({
          deliveries: [
            delivery('delivery-a', {
              shippingFee: Number.MAX_SAFE_INTEGER,
              customerShippingShare: 6_305_039_478_318_694,
              technicianShippingShare: 2_702_159_776_422_297,
            }),
            delivery('delivery-b'),
          ],
        }),
      ),
    ).toThrow('ORDER_SHIPPING_VND_OUT_OF_RANGE');
    expect(() =>
      assessOrderShippingLaborBudget(
        input({
          laborTotal: 0,
          deliveryRequestIds: [],
          deliveries: [],
        }),
      ),
    ).toThrow('ORDER_SHIPPING_INSUFFICIENT_NET_LABOR');
  });

  it('requires the versioned schema and explicit arrays even for zero-fee arithmetic', () => {
    expect(() =>
      assessOrderShippingLaborBudget(input({ version: undefined })),
    ).toThrow('ORDER_SHIPPING_INVALID_VERSION');
    expect(() => assessOrderShippingLaborBudget(null as never)).toThrow(
      'ORDER_SHIPPING_INVALID_SHAPE',
    );
    expect(
      assessOrderShippingLaborBudget(
        input({
          deliveries: [
            delivery('delivery-a', {
              shippingFee: 0,
              customerShippingShare: 0,
              technicianShippingShare: 0,
            }),
            delivery('delivery-b', {
              shippingFee: 0,
              customerShippingShare: 0,
              technicianShippingShare: 0,
            }),
          ],
        }),
      ),
    ).toMatchObject({
      technicianShippingShare: 0,
      netLaborAfterShipping: 17_000,
      financialExecution: 'BLOCKED',
    });
  });
});

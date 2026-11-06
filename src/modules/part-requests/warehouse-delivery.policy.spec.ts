import { describe, expect, it } from 'vitest';
import {
  assessDeliveryStock,
  advanceDelivery,
  DeliveryPhysicalState,
} from './warehouse-delivery.policy';

const items = [
  { partCatalogId: 'a', partSource: 'fixhome', quantity: 2 },
  { partCatalogId: 'b', partSource: 'fixhome', quantity: 3 },
];
const warehouse = { id: 'w', responsibleUserId: 'sm' };
const facts = () => ({
  fresh: true,
  delivery: true,
  approved: true,
  open: true,
  consentVerified: true,
  shippingApproved: true,
  items,
  warehouses: [warehouse],
  stocks: [
    { warehouseId: 'w', partId: 'a', onHand: 2, reserved: 0 },
    { warehouseId: 'w', partId: 'b', onHand: 3, reserved: 0 },
  ],
});
const evidence = {
  courierReference: 'courier-order-123',
  evidenceRef: 'private:handoff:123',
  contentDigest: 'a'.repeat(64),
};
describe('W3 physical delivery domain (facts are not client authority)', () => {
  it('reserves the entire request from one warehouse', () => {
    expect(assessDeliveryStock(facts())).toMatchObject({
      status: 'RESERVED',
      warehouseId: 'w',
      quantities: [
        { partId: 'a', quantity: 2 },
        { partId: 'b', quantity: 3 },
      ],
    });
  });
  it('does not combine warehouses or reserve a partial quantity', () => {
    const f = facts();
    f.warehouses.push({ id: 'x', responsibleUserId: 'other' });
    f.stocks[1].warehouseId = 'x';
    expect(assessDeliveryStock(f)).toMatchObject({
      status: 'PENDING_ASSISTANCE',
      reason: 'NO_SINGLE_WAREHOUSE',
      warehouseId: null,
      quantities: [],
    });
  });
  it.each(['fresh', 'delivery', 'approved', 'open'] as const)(
    'rejects missing %s',
    (key) => {
      expect(assessDeliveryStock({ ...facts(), [key]: false }).status).toBe(
        'INELIGIBLE',
      );
    },
  );
  it.each(['consentVerified', 'shippingApproved'] as const)(
    'does not infer %s from parts approval',
    (key) => {
      expect(assessDeliveryStock({ ...facts(), [key]: false })).toMatchObject({
        status: 'PENDING_ASSISTANCE',
        warehouseId: null,
        quantities: [],
      });
    },
  );
  it('rejects external/invalid/empty parts', () => {
    for (const invalid of [
      [],
      [{ ...items[0], partSource: 'technician' }],
      [{ ...items[0], quantity: 0 }],
    ]) {
      expect(assessDeliveryStock({ ...facts(), items: invalid }).status).toBe(
        'INELIGIBLE',
      );
    }
  });
  it('aggregates duplicate SKUs and chooses deterministically', () => {
    const f = facts();
    f.items = [items[0], items[0]];
    f.stocks[0].onHand = 4;
    expect(assessDeliveryStock(f).quantities).toEqual([
      { partId: 'a', quantity: 4 },
    ]);
  });
  it('requires three separate proof steps and never claims external verification/payment', () => {
    let state: DeliveryPhysicalState = {
      ...assessDeliveryStock(facts()),
      version: 1,
      courierReference: null,
      evidence: [],
    };
    state = advanceDelivery(state, 'ISSUE_TO_COURIER', evidence);
    expect(state.status).toBe('ISSUED_TO_COURIER');
    state = advanceDelivery(state, 'COURIER_DISPATCH', {
      ...evidence,
      evidenceRef: 'private:dispatch:123',
    });
    state = advanceDelivery(state, 'TECHNICIAN_RECEIPT', {
      ...evidence,
      evidenceRef: 'private:receipt:123',
    });
    expect(state.status).toBe('TECHNICIAN_RECEIVED');
    expect(state.evidence).toHaveLength(3);
    expect(
      state.evidence.every(
        (e) => e.verification === 'RECORDED_NOT_EXTERNALLY_VERIFIED',
      ),
    ).toBe(true);
    expect(state).not.toHaveProperty('paid');
  });
  it('does not accept receipt before dispatch or release after issue', () => {
    const state: DeliveryPhysicalState = {
      ...assessDeliveryStock(facts()),
      version: 1,
      courierReference: null,
      evidence: [],
    };
    expect(() =>
      advanceDelivery(state, 'TECHNICIAN_RECEIPT', evidence),
    ).toThrow();
    expect(() =>
      advanceDelivery(
        advanceDelivery(state, 'ISSUE_TO_COURIER', evidence),
        'RELEASE',
        null,
      ),
    ).toThrow();
  });
  it('binds reference throughout custody and requires distinct evidence per step', () => {
    const state: DeliveryPhysicalState = {
      ...assessDeliveryStock(facts()),
      version: 1,
      courierReference: null,
      evidence: [],
    };
    const issued = advanceDelivery(state, 'ISSUE_TO_COURIER', evidence);
    expect(() =>
      advanceDelivery(issued, 'COURIER_DISPATCH', {
        ...evidence,
        courierReference: 'different',
      }),
    ).toThrow();
    expect(() =>
      advanceDelivery(issued, 'COURIER_DISPATCH', evidence),
    ).toThrow();
    expect(() => advanceDelivery(state, 'ISSUE_TO_COURIER', null)).toThrow();
    expect(state.evidence).toEqual([]);
  });
});

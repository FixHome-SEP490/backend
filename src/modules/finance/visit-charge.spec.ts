import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { loadVisitCharge, sameAllocations, allocateFundedVisitCharge } from './visit-charge';

// PO 21/10/2026: a visit is paid once, after every device has its result, for the devices repaired only.
function manager(rows: { items: object[]; bookings: object[]; orders: object[]; invoices: object[] }) {
  const byName: Record<string, object[]> = { VisitGroupItem: rows.items, Booking: rows.bookings, ServiceOrder: rows.orders, Invoice: rows.invoices };
  return {
    find: vi.fn(async (entity: { name: string }) => byName[entity.name]),
    findBy: vi.fn(async (entity: { name: string }) => byName[entity.name]),
  };
}
const item = (sequence: number, outcome: string | null = null) => ({ groupId: 'g', sequence, bookingId: `b${sequence}`, deviceLabel: null, outcome });
const booking = (n: number, status = 'matched') => ({ id: `b${n}`, status, serviceNameSnapshot: `Dịch vụ ${n}` });
const order = (n: number, extra: object = {}) => ({ id: `o${n}`, bookingId: `b${n}`, code: `FH-${n}`, status: 'under_repair', completionRequestedAt: new Date(), ...extra });
const invoice = (n: number, grandTotal: number, paymentStatus = 'unpaid') => ({ id: `i${n}`, serviceOrderId: `o${n}`, grandTotal: String(grandTotal), paymentStatus });

describe('loadVisitCharge', () => {
  it('stops only the interrupted child from waiting or charging while preserving old invoices', async () => {
    const rows = { items: [item(1), item(2, 'interrupted'), item(3)],
      bookings: [booking(1), booking(2), booking(3)],
      orders: [order(1), order(2), order(3)],
      invoices: [invoice(1, 200000), invoice(2, 700000, 'paid'), invoice(3, 300000)] };
    const before = structuredClone(rows);
    const charge = await loadVisitCharge(manager(rows) as never, 'g');
    expect(charge).toMatchObject({ ready: false, paid: false, waiting: 0, total: 500000, financialFollowupRequired: true });
    expect(charge.devices[1]).toMatchObject({ state: 'interrupted', amount: 700000, invoiceId: 'i2', paid: true, financialFollowupRequired: true });
    expect(charge.allocations.map(a => a.invoiceId)).toEqual(['i1', 'i3']);
    expect(rows).toEqual(before);
  });

  it('holds an interrupted pending invoice without changing its old group allocation or provider split', async () => {
    const rows = { items: [item(1), item(2)], bookings: [booking(1), booking(2)],
      orders: [order(1), order(2)], invoices: [invoice(1, 200000), invoice(2, 700000)] };
    const before = await loadVisitCharge(manager(rows) as never, 'g');
    rows.items[1].outcome = 'interrupted'; const snapshot = structuredClone(rows);
    const stopped = await loadVisitCharge(manager(rows) as never, 'g');
    expect(stopped).toMatchObject({ ready: false, paid: false, financialFollowupRequired: true, total: before.total });
    expect(stopped.devices[1]).toMatchObject({ amount: 700000, paid: false, invoiceId: 'i2' });
    expect(stopped.allocations).toEqual(before.allocations);
    expect(sameAllocations(before.allocations, stopped.allocations)).toBe(true);
    expect(rows).toEqual(snapshot);
  });

  it('allows the existing single sibling checkout only when the stopped child has no invoice', async () => {
    const charge = await loadVisitCharge(manager({ items: [item(1), item(2, 'interrupted'), item(3)],
      bookings: [booking(1), booking(2), booking(3)], orders: [order(1), order(2, { completionRequestedAt: null }), order(3)],
      invoices: [invoice(1, 200000), invoice(3, 300000)] }) as never, 'g');
    expect(charge).toMatchObject({ ready: true, waiting: 0, total: 500000 });
    expect(charge.allocations.map(a => a.invoiceId)).toEqual(['i1', 'i3']);
  });
  it('charges the repaired devices only, once nothing is still open', async () => {
    const charge = await loadVisitCharge(manager({
      items: [item(1), item(2, 'failed'), item(3, 'quote_declined')],
      bookings: [booking(1), booking(2, 'cancelled'), booking(3, 'cancelled')],
      orders: [order(1), order(2, { status: 'cancelled' }), order(3, { status: 'cancelled' })],
      invoices: [invoice(1, 250000)],
    }) as never, 'g');
    expect(charge.devices.map((d) => [d.state, d.amount])).toEqual([['succeeded', 250000], ['failed', 0], ['quote_declined', 0]]);
    expect(charge).toMatchObject({ ready: true, paid: false, waiting: 0, total: 250000, allocations: [{ invoiceId: 'i1', serviceOrderId: 'o1', amount: 250000 }] });
  });

  it('keeps all successful sibling invoices when one device is manager interrupted', async () => {
    const charge = await loadVisitCharge(manager({
      items: [item(1), item(2, 'interrupted'), item(3)],
      bookings: [booking(1), booking(2, 'cancelled'), booking(3)],
      orders: [order(1), order(2, { status: 'cancelled', completionRequestedAt: null }), order(3)],
      invoices: [invoice(1, 200000), invoice(3, 300000)],
    }) as never, 'g');
    expect(charge.devices.map(device => [device.state, device.amount])).toEqual([
      ['succeeded', 200000], ['cancelled', 0], ['succeeded', 300000],
    ]);
    expect(charge).toMatchObject({ ready: true, waiting: 0, total: 500000 });
    expect(charge.allocations.map(allocation => allocation.invoiceId)).toEqual(['i1', 'i3']);
  });

  it('waits while a device has no result yet', async () => {
    const charge = await loadVisitCharge(manager({
      items: [item(1), item(2)], bookings: [booking(1), booking(2)],
      orders: [order(1), order(2, { completionRequestedAt: null })], invoices: [invoice(1, 100000)],
    }) as never, 'g');
    expect(charge).toMatchObject({ ready: false, waiting: 1, total: 100000 });
  });

  it('owes nothing once the repaired devices are paid, and nothing when none was repaired', async () => {
    const paid = await loadVisitCharge(manager({ items: [item(1)], bookings: [booking(1)], orders: [order(1)], invoices: [invoice(1, 100000, 'paid')] }) as never, 'g');
    expect(paid).toMatchObject({ ready: false, paid: true, total: 0 });
    const none = await loadVisitCharge(manager({ items: [item(1, 'failed')], bookings: [booking(1, 'cancelled')], orders: [order(1, { status: 'cancelled' })], invoices: [] }) as never, 'g');
    expect(none).toMatchObject({ ready: false, paid: false, total: 0 });
  });
});

describe('sameAllocations', () => {
  it('matches invoice for invoice, in any order', () => {
    const a = [{ invoiceId: 'i1', serviceOrderId: 'o1', amount: 100 }, { invoiceId: 'i2', serviceOrderId: 'o2', amount: 200 }];
    expect(sameAllocations(a, [...a].reverse())).toBe(true);
    expect(sameAllocations(a, [a[0]])).toBe(false);
    expect(sameAllocations(a, [a[0], { ...a[1], amount: 201 }])).toBe(false);
  });
});

describe('funded visit charge allocation', () => {
  const charge = {
    devices: [], waiting: 0, ready: true, paid: false, total: 300000,
    allocations: [
      { invoiceId: 'i1', serviceOrderId: 'o1', amount: 100000 },
      { invoiceId: 'i2', serviceOrderId: 'o2', amount: 200000 },
    ],
  };
  const funding = {
    total: { originalGrossVnd: 300000, customerDueVnd: 240000 },
    invoices: [
      { invoiceId: 'i1', originalGrossVnd: 100000, customerDueVnd: 80000 },
      { invoiceId: 'i2', originalGrossVnd: 200000, customerDueVnd: 160000 },
    ],
  };
  it('produces a net payment split without changing frozen gross allocations', () => {
    expect(allocateFundedVisitCharge(charge, funding as never)).toEqual({
      originalGross: 300000, customerDue: 240000,
      allocations: [
        { invoiceId: 'i1', serviceOrderId: 'o1', amount: 80000 },
        { invoiceId: 'i2', serviceOrderId: 'o2', amount: 160000 },
      ],
    });
    expect(charge.allocations.map(item => item.amount)).toEqual([100000, 200000]);
  });
  it.each(['wrong gross', 'missing child', 'duplicate child', 'wrong due'])(
    'rejects %s before a payment record can be created', variant => {
      const quote = structuredClone(funding);
      if (variant === 'wrong gross') quote.invoices[0].originalGrossVnd += 1;
      if (variant === 'missing child') quote.invoices.pop();
      if (variant === 'duplicate child') quote.invoices[1].invoiceId = 'i1';
      if (variant === 'wrong due') quote.total.customerDueVnd += 1;
      expect(() => allocateFundedVisitCharge(charge, quote as never)).toThrow();
    },
  );
});

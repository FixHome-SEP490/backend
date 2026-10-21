import { EntityManager, In } from 'typeorm';
import { BookingStatus, PaymentStatus, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import type { VisitPaymentAllocation } from '../visit-groups/entities/visit-group-payment.entity';

/** Where one device of a visit stands for the visit's single payment. */
export type VisitDeviceState = 'succeeded' | 'failed' | 'quote_declined' | 'cancelled' | 'open';

export interface VisitDeviceCharge {
  sequence: number;
  deviceLabel: string | null;
  bookingId: string;
  serviceName: string | null;
  serviceOrderId: string | null;
  orderCode: string | null;
  state: VisitDeviceState;
  invoiceId: string | null;
  amount: number;
  paid: boolean;
}

export interface VisitCharge {
  devices: VisitDeviceCharge[];
  /** Unpaid invoices of the devices repaired, the split of the one payment. */
  allocations: VisitPaymentAllocation[];
  total: number;
  /** Devices still being worked on; the visit is paid once none is (PO 21/10/2026, D-MV-19). */
  waiting: number;
  ready: boolean;
  paid: boolean;
}

/**
 * The visit's single payment as the server sees it now (PO 21/10/2026): only
 * devices repaired are charged (their invoice was issued when the technician
 * reported completion); a refused quote, "không sửa được" or a cancelled device
 * costs nothing. With `lock`, the invoices are locked in id order, so a payment
 * applies exactly the amounts it read.
 */
export async function loadVisitCharge(manager: EntityManager, groupId: string, lock = false): Promise<VisitCharge> {
  const items = await manager.find(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
  const bookingIds = items.map((item) => item.bookingId);
  const bookings = bookingIds.length ? await manager.findBy(Booking, { id: In(bookingIds) }) : [];
  const orders = bookingIds.length ? await manager.findBy(ServiceOrder, { bookingId: In(bookingIds) }) : [];
  const orderIds = orders.map((order) => order.id);
  const invoices = orderIds.length
    ? await manager.find(Invoice, { where: { serviceOrderId: In(orderIds) }, order: { id: 'ASC' }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) })
    : [];
  const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
  const orderByBooking = new Map(orders.map((order) => [order.bookingId, order]));
  const invoiceByOrder = new Map(invoices.map((invoice) => [invoice.serviceOrderId, invoice]));

  const devices = items.map((item): VisitDeviceCharge => {
    const booking = bookingById.get(item.bookingId);
    const order = orderByBooking.get(item.bookingId) ?? null;
    const invoice = order ? invoiceByOrder.get(order.id) ?? null : null;
    let state: VisitDeviceState = 'open';
    if (item.outcome === 'failed' || item.outcome === 'quote_declined') state = item.outcome;
    else if (booking?.status === BookingStatus.CANCELLED || order?.status === ServiceOrderStatus.CANCELLED) state = 'cancelled';
    else if (order?.completionRequestedAt && invoice) state = 'succeeded';
    const charged = state === 'succeeded' && invoice ? Number(invoice.grandTotal) : 0;
    return {
      sequence: item.sequence,
      deviceLabel: item.deviceLabel ?? null,
      bookingId: item.bookingId,
      serviceName: booking?.serviceNameSnapshot ?? null,
      serviceOrderId: order?.id ?? null,
      orderCode: order?.code ?? null,
      state,
      invoiceId: state === 'succeeded' ? invoice?.id ?? null : null,
      amount: charged,
      paid: state === 'succeeded' && invoice?.paymentStatus === PaymentStatus.PAID,
    };
  });
  const allocations = devices
    .filter((device) => device.state === 'succeeded' && !device.paid && device.amount > 0)
    .map((device) => ({ invoiceId: device.invoiceId!, serviceOrderId: device.serviceOrderId!, amount: device.amount }));
  const waiting = devices.filter((device) => device.state === 'open').length;
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  return {
    devices,
    allocations,
    total,
    waiting,
    ready: waiting === 0 && allocations.length > 0,
    paid: waiting === 0 && allocations.length === 0 && devices.some((device) => device.state === 'succeeded'),
  };
}

/** True when a payment's frozen split still matches what is owed now, invoice for invoice. */
export function sameAllocations(frozen: VisitPaymentAllocation[], now: VisitPaymentAllocation[]): boolean {
  const key = (list: VisitPaymentAllocation[]) => list.map((a) => `${a.invoiceId}:${Number(a.amount)}`).sort().join('|');
  return frozen.length === now.length && key(frozen) === key(now);
}

// Customer "Hoạt động" lists, classified on the server so a client can page and count without loading everything.
// Repair orders are the ones a technician holds (or finished); an order that lost its technician is a booking request again.

export const REQUEST_STAGES = ['no_technician', 'sent', 'cancelled'] as const;
export type RequestStage = (typeof REQUEST_STAGES)[number];
export const REPAIR_STAGES = ['in_progress', 'completed', 'cancelled'] as const;
export type RepairStage = (typeof REPAIR_STAGES)[number];

/** An order waiting for a replacement technician: accepted or en route with nobody active on it. */
export function replacementOrderSql(order = 'o'): string {
  return `(${order}.status IN ('accepted', 'en_route') AND NOT EXISTS (SELECT 1 FROM technician_assignments ta WHERE ta.service_order_id = ${order}.id AND ta.is_active = true))`;
}

const hasReplacementOrder = (booking: string) =>
  `EXISTS (SELECT 1 FROM service_orders ro WHERE ro.booking_id = ${booking}.id AND ${replacementOrderSql('ro')})`;

// A booking that reached an order is that repair order from then on: when the order is cancelled the
// booking turns cancelled (or closed) too, and it is listed once, as the cancelled repair order.
const hasOrder = (booking: string) =>
  `EXISTS (SELECT 1 FROM service_orders bo WHERE bo.booking_id = ${booking}.id)`;

/** Bookings that are requests. A matched booking is a repair order, so it is in no request stage. */
export function bookingStageSql(stage: RequestStage, booking = 'b'): string {
  switch (stage) {
    case 'cancelled':
      return `(${booking}.status = 'cancelled' AND NOT ${hasOrder(booking)})`;
    case 'no_technician':
      return `(${booking}.status <> 'cancelled' AND ((${booking}.status = 'closed' AND NOT ${hasOrder(booking)}) OR ${hasReplacementOrder(booking)}))`;
    case 'sent':
      return `(${booking}.status IN ('submitted', 'matching') AND NOT ${hasReplacementOrder(booking)})`;
  }
}

export function orderStageSql(stage: RepairStage, order = 'o'): string {
  switch (stage) {
    case 'completed':
      return `${order}.status = 'completed'`;
    case 'cancelled':
      return `${order}.status = 'cancelled'`;
    case 'in_progress':
      return `(${order}.status IN ('accepted', 'en_route', 'under_repair') AND NOT ${replacementOrderSql(order)})`;
  }
}

export interface CustomerActivityCounts {
  repair: { all: number; in_progress: number; completed: number; cancelled: number };
  request: { all: number; no_technician: number; sent: number; cancelled: number };
}

// Customer lists put what is still going on first (PO 19/11/2026): 0 for a request still
// waiting for a technician or an order being worked on, 1 for done or cancelled. Each
// group stays newest first; the callers add created_at DESC and id DESC after it.
export const ACTIVE_RANK_ALIAS = 'active_rank';
export const orderActiveRankSql = (order = 'o') =>
  `CASE WHEN ${order}.status IN ('accepted', 'en_route', 'under_repair') THEN 0 ELSE 1 END`;
export const bookingActiveRankSql = (booking = 'b') =>
  `CASE WHEN ${booking}.status IN ('submitted', 'matching', 'closed') THEN 0 ELSE 1 END`;
export const visitActiveRankSql = (statusSql: string) =>
  `CASE WHEN (${statusSql}) IN ('submitted', 'matching', 'no_technician', 'accepted', 'en_route', 'under_repair') THEN 0 ELSE 1 END`;

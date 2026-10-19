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

/** Bookings that are requests. A matched booking is a repair order, so it is in no request stage. */
export function bookingStageSql(stage: RequestStage, booking = 'b'): string {
  switch (stage) {
    case 'cancelled':
      return `${booking}.status = 'cancelled'`;
    case 'no_technician':
      return `(${booking}.status <> 'cancelled' AND (${booking}.status = 'closed' OR ${hasReplacementOrder(booking)}))`;
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

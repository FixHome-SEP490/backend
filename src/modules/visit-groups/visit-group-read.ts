export const VISIT_GROUP_READ_STATUSES = [
  'submitted',
  'matching',
  'no_technician',
  'accepted',
  'en_route',
  'under_repair',
  'completed',
  'cancelled',
  'failed',
  'quote_declined',
  'mixed',
] as const;

export type VisitGroupReadStatus = (typeof VISIT_GROUP_READ_STATUSES)[number];

export const VISIT_GROUP_TECHNICIAN_TABS = [
  'all',
  'in_progress',
  'accepted',
  'en_route',
  'under_repair',
  'completed',
  'cancelled',
  'failed',
  'quote_declined',
  'mixed',
] as const;

export type VisitGroupTechnicianTab = (typeof VISIT_GROUP_TECHNICIAN_TABS)[number];

export interface VisitGroupReadItemStatus {
  bookingStatus?: string | null;
  orderStatus?: string | null;
  outcome?: string | null;
  hasActiveAssignment?: boolean;
}

const isTerminal = (item: VisitGroupReadItemStatus) =>
  item.outcome != null ||
  item.orderStatus === 'completed' ||
  item.orderStatus === 'cancelled' ||
  item.bookingStatus === 'cancelled';

/** Derive the parent row's status from its child lifecycle; VisitGroup.status is only a legacy submitted/cancelled marker. */
export function deriveVisitGroupStatus(items: readonly VisitGroupReadItemStatus[]): VisitGroupReadStatus {
  if (items.some((item) => item.orderStatus === 'under_repair')) return 'under_repair';
  if (items.some((item) => item.orderStatus === 'en_route' && item.hasActiveAssignment)) return 'en_route';
  if (items.some((item) => item.orderStatus === 'accepted' && item.hasActiveAssignment)) return 'accepted';
  if (
    items.some((item) => item.bookingStatus === 'closed') ||
    items.some((item) => ['accepted', 'en_route'].includes(item.orderStatus ?? '') && !item.hasActiveAssignment)
  ) return 'no_technician';

  if (items.length && items.every(isTerminal)) {
    if (items.every((item) => item.outcome == null && (item.orderStatus === 'cancelled' || (item.bookingStatus === 'cancelled' && item.orderStatus == null)))) {
      return 'cancelled';
    }
    if (items.every((item) => item.outcome === 'failed')) return 'failed';
    if (items.every((item) => item.outcome === 'quote_declined')) return 'quote_declined';
    if (items.every((item) => item.outcome === 'succeeded' || (item.outcome == null && item.orderStatus === 'completed'))) return 'completed';
    return 'mixed';
  }

  if (items.some((item) => item.bookingStatus === 'matching')) return 'matching';
  if (items.some((item) => item.bookingStatus === 'submitted')) return 'submitted';
  return 'no_technician';
}

/** Parameter-free, fixed SQL expression used to filter parent rows before COUNT/OFFSET/LIMIT. */
export function visitGroupStatusSql(groupAlias = 'vg'): string {
  const childExists = (condition: string) => `EXISTS (
    SELECT 1 FROM visit_group_items vgi
    JOIN bookings vb ON vb.id = vgi.booking_id
    LEFT JOIN service_orders vo ON vo.booking_id = vb.id
    WHERE vgi.group_id = ${groupAlias}.id AND (${condition})
  )`;
  const childrenExcept = (condition: string) => `EXISTS (
    SELECT 1 FROM visit_group_items vgi
    JOIN bookings vb ON vb.id = vgi.booking_id
    LEFT JOIN service_orders vo ON vo.booking_id = vb.id
    WHERE vgi.group_id = ${groupAlias}.id AND NOT (${condition})
  )`;
  const hasActiveOrder = (status: string) => `EXISTS (
    SELECT 1 FROM visit_group_items vgi
    JOIN service_orders vo ON vo.booking_id = vgi.booking_id
    JOIN technician_assignments vta ON vta.service_order_id = vo.id AND vta.is_active = true
    WHERE vgi.group_id = ${groupAlias}.id AND vo.status = '${status}'
  )`;
  const hasChildren = childExists('true');
  const allTerminal = `${hasChildren} AND NOT ${childrenExcept("vgi.outcome IS NOT NULL OR vo.status IN ('completed', 'cancelled') OR vb.status = 'cancelled'")}`;
  const allCancelled = `${hasChildren} AND NOT ${childrenExcept("vgi.outcome IS NULL AND (vo.status = 'cancelled' OR (vb.status = 'cancelled' AND vo.id IS NULL))")}`;
  const allFailed = `${hasChildren} AND NOT ${childrenExcept("vgi.outcome = 'failed'")}`;
  const allQuoteDeclined = `${hasChildren} AND NOT ${childrenExcept("vgi.outcome = 'quote_declined'")}`;
  const allSucceeded = `${hasChildren} AND NOT ${childrenExcept("vgi.outcome = 'succeeded' OR (vgi.outcome IS NULL AND vo.status = 'completed')")}`;

  return `CASE
    WHEN ${childExists("vo.status = 'under_repair'")} THEN 'under_repair'
    WHEN ${hasActiveOrder('en_route')} THEN 'en_route'
    WHEN ${hasActiveOrder('accepted')} THEN 'accepted'
    WHEN ${childExists("vb.status = 'closed' OR (vo.status IN ('accepted', 'en_route') AND NOT EXISTS (SELECT 1 FROM technician_assignments vta WHERE vta.service_order_id = vo.id AND vta.is_active = true))")} THEN 'no_technician'
    WHEN ${allTerminal} AND ${allCancelled} THEN 'cancelled'
    WHEN ${allTerminal} AND ${allFailed} THEN 'failed'
    WHEN ${allTerminal} AND ${allQuoteDeclined} THEN 'quote_declined'
    WHEN ${allTerminal} AND ${allSucceeded} THEN 'completed'
    WHEN ${allTerminal} THEN 'mixed'
    WHEN ${childExists("vb.status = 'matching'")} THEN 'matching'
    WHEN ${childExists("vb.status = 'submitted'")} THEN 'submitted'
    ELSE 'no_technician'
  END`;
}

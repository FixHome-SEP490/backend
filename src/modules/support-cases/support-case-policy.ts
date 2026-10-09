import { Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';

export const SUPPORT_CASE_POST_COMPLETION_WINDOW_DAYS = 7;
export const SUPPORT_CASE_MAX_OPEN_PER_ORDER = 3;
// ponytail: wall-clock minutes, business-hours calendar when the SM roster is fixed
export const SUPPORT_CASE_ACTIVE_ORDER_RESPOND_MINUTES = 30;

type ActorRole = Role.CUSTOMER | Role.TECHNICIAN;
type Phase = ServiceOrderStatus | 'no_order';

const S = SupportCaseType;

/** Case types an actor may open per order phase; system-only types are never listed. */
const ALLOWED: Record<ActorRole, Record<Phase, SupportCaseType[]>> = {
  [Role.CUSTOMER]: {
    no_order: [S.MATCHING_EXHAUSTED, S.OTHER],
    [ServiceOrderStatus.ACCEPTED]: [S.ARRIVAL_ABNORMAL, S.CANCELLATION_REVIEW, S.CONDUCT, S.OTHER],
    [ServiceOrderStatus.EN_ROUTE]: [S.ARRIVAL_ABNORMAL, S.CANCELLATION_REVIEW, S.CONDUCT, S.OTHER],
    [ServiceOrderStatus.UNDER_REPAIR]: [
      S.MID_JOB_INTERRUPTION, S.PARTS_DISPUTE, S.PRICING_DISPUTE,
      S.PROPERTY_DAMAGE, S.QUALITY, S.CONDUCT, S.OTHER,
    ],
    [ServiceOrderStatus.COMPLETED]: [
      S.QUALITY, S.PROPERTY_DAMAGE, S.PRICING_DISPUTE, S.PARTS_DISPUTE,
      S.CASH_MISMATCH, S.CONDUCT, S.OTHER,
    ],
    [ServiceOrderStatus.CANCELLED]: [S.CANCELLATION_REVIEW, S.OTHER],
  },
  [Role.TECHNICIAN]: {
    no_order: [],
    [ServiceOrderStatus.ACCEPTED]: [S.ARRIVAL_ABNORMAL, S.CONDUCT, S.OTHER],
    [ServiceOrderStatus.EN_ROUTE]: [S.ARRIVAL_ABNORMAL, S.TECHNICIAN_REPLACEMENT, S.CONDUCT, S.OTHER],
    [ServiceOrderStatus.UNDER_REPAIR]: [
      S.MID_JOB_INTERRUPTION, S.PARTS_DISPUTE, S.PRICING_DISPUTE,
      S.PROPERTY_DAMAGE, S.TECHNICIAN_REPLACEMENT, S.CONDUCT, S.OTHER,
    ],
    [ServiceOrderStatus.COMPLETED]: [S.CASH_MISMATCH, S.CONDUCT, S.OTHER],
    [ServiceOrderStatus.CANCELLED]: [S.CANCELLATION_REVIEW, S.OTHER],
  },
};

export interface SupportCaseOpenContext {
  role: ActorRole;
  orderStatus: ServiceOrderStatus | null;
  completedAt?: Date | null;
  now?: Date;
}

export function allowedCaseTypes(ctx: SupportCaseOpenContext): SupportCaseType[] {
  return ALLOWED[ctx.role][ctx.orderStatus ?? 'no_order'] ?? [];
}

export function isCompletionWindowOpen(
  completedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!completedAt) return true;
  const windowMs = SUPPORT_CASE_POST_COMPLETION_WINDOW_DAYS * 86_400_000;
  return now.getTime() - new Date(completedAt).getTime() <= windowMs;
}

export function respondByFor(
  orderStatus: ServiceOrderStatus | null,
  isUrgent: boolean,
  now: Date = new Date(),
): Date | null {
  const active =
    orderStatus === ServiceOrderStatus.EN_ROUTE ||
    orderStatus === ServiceOrderStatus.UNDER_REPAIR;
  return active || isUrgent
    ? new Date(now.getTime() + SUPPORT_CASE_ACTIVE_ORDER_RESPOND_MINUTES * 60_000)
    : null;
}

/** Outcomes a manager may record on a case that is not a cash reconciliation. */
export const COMPLAINT_RESOLUTION_CODES = [
  'no_action',
  'warning_issued',
  'worker_reassigned',
  'order_cancelled_no_fee',
  'price_adjusted',
  'refund_recorded',
  // Money back into the customer's wallet (PO 08/10/2026); needs an amount.
  'refund_to_wallet',
  'escalate_admin',
  'warranty_upheld',
  'warranty_overturned',
] as const;

export const LIABLE_PARTIES = ['technician', 'customer', 'platform', 'shared'] as const;

/**
 * Money goes back into the customer's wallet only for a faulty part or a
 * warranty failure (PO 09/10/2026). FixHome bears it; charging the technician
 * afterwards is an admin wallet adjustment.
 */
export const REFUND_CASE_TYPES = [SupportCaseType.PARTS_DISPUTE, SupportCaseType.WARRANTY_DISPUTE] as const;

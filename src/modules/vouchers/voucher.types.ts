import { Role } from '../../shared/enums';

export enum VoucherKind {
  GENERAL = 'GENERAL',
  PERSONAL = 'PERSONAL',
}
export enum VoucherCampaignState {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}
export type VoucherSourceKind = 'VISIT_GROUP' | 'SOLO' | 'ADMIN_GRANT';
export enum VoucherDiscount {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
}
export enum ReservationState {
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
  REDEEMED = 'REDEEMED',
  REFUNDED = 'REFUNDED',
}
export interface VoucherActor {
  id: string;
  role: Role;
}
export interface VoucherPolicy {
  discount: VoucherDiscount;
  value: number;
  capVnd: number | null;
  minimumVnd: number;
  categoryIds: string[];
  serviceIds: string[];
  components: ['LABOR', 'PARTS'];
}
export interface CheckoutFacts {
  scopeId: string;
  customerId: string;
  snapshotId: string;
  finalized: true;
  paymentState: 'NOT_STARTED';
  eligibleSubtotalVnd: number;
  // Only billable, approved, actual-used lines from finalized invoices.
  items: { categoryId: string; serviceId: string }[];
}
export interface FailureFacts {
  // Adapter canonicalizes every failed child to its parent VisitGroup.
  sourceKind: 'VISIT_GROUP' | 'SOLO';
  sourceId: string;
  customerId: string;
  eligible: true;
  reason: 'REPAIR_FAILED';
}
/** Internal delivery contract only. The event is a hint to re-read a persisted incident;
 * it does not authorize issuance, supply an owner, or bypass canonical VisitGroup resolution. */
export interface RepairFailureVoucherEvent {
  type: 'REPAIR_FAILURE_ELIGIBLE_V1';
  incidentId: string;
}
export interface SettlementFacts {
  settlementId: string;
  reservationId: string;
  customerId: string;
  scopeId: string;
  snapshotId: string;
  status: 'SETTLED';
  settledAt: Date;
}
export const APPLY_TTL_MS = 15 * 60 * 1000;

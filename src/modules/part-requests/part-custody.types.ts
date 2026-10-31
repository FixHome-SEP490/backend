import { PartRequestStatus, PartRequestType, PartSource, Role, ServiceOrderStatus } from '../../shared/enums';
import type { LegacyManualReviewDto, LegacyReviewStatus } from './dto/legacy-manual-review.dto';

export interface LegacyManualReviewEvent extends LegacyManualReviewDto {
  readonly id: string;
  readonly version: number;
  readonly actorUserId: string;
  readonly actorRole: Role.SERVICE_MANAGER;
  readonly occurredAt: string;
  readonly orderId: string;
  readonly technicianId: string;
  readonly partRequestId: string;
  readonly partRequestItemId: string;
}

export type PartCustodyCommandKind =
  | 'record_usage'
  | 'declare_return'
  | 'accept_return'
  | 'report_discrepancy';

interface PartCustodyCommandBase {
  readonly partRequestId: string;
  readonly partRequestItemId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly evidenceReferenceId?: string;
}

export type PartCustodyCommand =
  | (PartCustodyCommandBase & { readonly kind: 'record_usage'; readonly usedQty: number })
  | (PartCustodyCommandBase & { readonly kind: 'declare_return'; readonly quantity: number })
  | (PartCustodyCommandBase & { readonly kind: 'accept_return'; readonly quantity: number })
  | (PartCustodyCommandBase & {
      readonly kind: 'report_discrepancy';
      readonly declaredQty: number;
      readonly observedQty: number;
    });

export interface PartCustodyActor {
  readonly id: string;
  readonly role: Role | string;
}

/**
 * Legacy FixHome parts handed to a technician before custody enrollment. The
 * physical return state is unknown, so this record never carries accepted,
 * declared or outstanding quantities. `handedOverAt` is only the existing
 * request receipt evidence, not a warehouse return receipt.
 */
export interface LegacyManualReviewRecord {
  readonly kind: 'legacy_manual_review';
  readonly receiptState: 'UNKNOWN';
  readonly orderId: string;
  readonly partRequestId: string;
  readonly partRequestItemId: string;
  readonly technicianId: string;
  readonly requestType: PartRequestType;
  readonly requestStatus: PartRequestStatus;
  readonly handedOverAt: string;
  readonly partCatalogId: string | null;
  readonly partNameSnapshot: string;
  readonly issuedQty: number;
  readonly manualReviewState: 'UNKNOWN' | LegacyReviewStatus;
  readonly lastManualReview: LegacyManualReviewEvent | null;
}

export interface PartCustodyDeclaration {
  readonly quantity: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly declaredAt: string;
  readonly idempotencyKey: string;
  readonly evidenceReferenceId?: string;
}

export interface PartCustodyReceipt {
  readonly quantity: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly acceptedAt: string;
  readonly idempotencyKey: string;
  readonly evidenceReferenceId?: string;
}

export type PartCustodyAuditEventType =
  | 'USAGE_RECORDED'
  | 'RETURN_DECLARED'
  | 'RETURN_ACCEPTED'
  | 'DISCREPANCY';

export interface PartCustodyAuditEvent {
  readonly id: string;
  readonly type: PartCustodyAuditEventType;
  readonly partRequestId: string;
  readonly partRequestItemId: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly quantity?: number;
  readonly usedQty?: number;
  readonly declaredQty?: number;
  readonly observedQty?: number;
  readonly reasonProvided?: boolean;
  readonly evidenceReferenceId?: string;
}

export interface PartCustodyOutcome {
  readonly kind: PartCustodyCommandKind;
  readonly version: number;
  readonly usedQty: number;
  readonly returnDueQty: number;
  readonly managerAcceptedQty: number;
  readonly unresolvedQty: number;
  readonly outstandingQty: number;
}

export interface PartCustodyIdempotencyRecord {
  readonly key: string;
  readonly requestFingerprint: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly events: readonly PartCustodyAuditEvent[];
  readonly outcome: PartCustodyOutcome;
}

export interface PartCustodySnapshotInput {
  readonly serviceOrderId: string;
  readonly partRequestId: string;
  readonly partRequestItemId: string;
  readonly requestType: PartRequestType;
  readonly additionalCostId: string | null;
  readonly quotationId?: string | null;
  readonly partCatalogId: string | null;
  readonly source: PartSource;
  readonly originalCustodianTechnicianId: string;
  readonly issuedQty: number;
  readonly usedQty: number;
  readonly serviceOrderStatus: ServiceOrderStatus;
  readonly invoiceFrozen: boolean;
}

export interface PartCustodySnapshot extends PartCustodySnapshotInput {
  readonly returnDueQty: number;
  readonly managerAcceptedQty: number;
  readonly unresolvedQty: number;
  readonly outstandingQty: number;
  readonly explicitlyApprovedDispositionQty: 0;
  readonly version: number;
  readonly declarations: readonly PartCustodyDeclaration[];
  readonly receipts: readonly PartCustodyReceipt[];
  readonly events: readonly PartCustodyAuditEvent[];
  readonly idempotencyKeys: readonly PartCustodyIdempotencyRecord[];
}

export interface PartCustodyCommandResult {
  readonly next: PartCustodySnapshot;
  readonly events: readonly PartCustodyAuditEvent[];
  readonly replayed: boolean;
  readonly outcome: PartCustodyOutcome;
}

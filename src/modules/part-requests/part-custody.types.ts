import { PartRequestType, PartSource, Role, ServiceOrderStatus } from '../../shared/enums';

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

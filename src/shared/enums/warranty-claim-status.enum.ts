// src/shared/enums/warranty-claim-status.enum.ts
export enum WarrantyClaimStatus {
  SUBMITTED = 'submitted',
  ACCEPTED = 'accepted',
  INSPECTED = 'inspected',
  IN_PROGRESS = 'in_progress',
  AWAITING_CUSTOMER = 'awaiting_customer',
  DISPUTED = 'disputed',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

/** A coverage can only carry one claim in these states at a time. */
export const WARRANTY_CLAIM_ACTIVE_STATUSES = [
  WarrantyClaimStatus.SUBMITTED,
  WarrantyClaimStatus.ACCEPTED,
  WarrantyClaimStatus.INSPECTED,
  WarrantyClaimStatus.IN_PROGRESS,
  WarrantyClaimStatus.AWAITING_CUSTOMER,
  WarrantyClaimStatus.DISPUTED,
] as const;

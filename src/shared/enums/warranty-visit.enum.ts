// src/shared/enums/warranty-visit.enum.ts
export enum WarrantyVisitStatus {
  SCHEDULED = 'scheduled',
  CHECKED_IN = 'checked_in',
  INSPECTED = 'inspected',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum WarrantyInspectionResult {
  COVERED_WORKMANSHIP = 'covered_workmanship',
  COVERED_PART = 'covered_part',
  NOT_COVERED = 'not_covered',
}

/** Why the technician concludes a claim is not covered. */
export enum WarrantyNotCoveredReason {
  CUSTOMER_MISUSE = 'customer_misuse',
  NORMAL_WEAR = 'normal_wear',
  OTHER_COMPONENT = 'other_component',
  NOT_WORKMANSHIP_RELATED = 'not_workmanship_related',
  EXPIRED = 'expired',
  CANNOT_REPRODUCE = 'cannot_reproduce',
  CUSTOMER_UNAVAILABLE = 'customer_unavailable',
  OTHER = 'other',
}

/** Why the assigned technician cannot take a claim. */
export enum WarrantyDeclineReason {
  BUSY = 'busy',
  ON_LEAVE = 'on_leave',
  OUT_OF_AREA = 'out_of_area',
  OTHER = 'other',
}

/** What the customer is asked to answer while a claim is awaiting_customer. */
export enum WarrantyCustomerPrompt {
  CONCLUSION = 'conclusion',
  COMPLETION = 'completion',
}

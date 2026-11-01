export enum SupportCaseType {
  MATCHING_EXHAUSTED = 'matching_exhausted',
  ARRIVAL_ABNORMAL = 'arrival_abnormal',
  CASH_NON_RESPONSE = 'cash_non_response',
  CASH_MISMATCH = 'cash_mismatch',
  CANCELLATION_REVIEW = 'cancellation_review',
  PARTS_DISPUTE = 'parts_dispute',
  WARRANTY_DISPUTE = 'warranty_dispute',
  MID_JOB_INTERRUPTION = 'mid_job_interruption',
  PROPERTY_DAMAGE = 'property_damage',
  QUALITY = 'quality',
  PRICING_DISPUTE = 'pricing_dispute',
  CONDUCT = 'conduct',
  OTHER = 'other',
  /** Technician on site: the job is outside their skills, the manager sends someone else (PO 08/10/2026). */
  TECHNICIAN_REPLACEMENT = 'technician_replacement',
  /** Technician still on another job reports the next order will be late or released (PO 31/10/2026); system-opened, the manager only reads it. */
  TECHNICIAN_DELAY = 'technician_delay',
}

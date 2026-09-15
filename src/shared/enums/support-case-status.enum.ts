export enum SupportCaseStatus {
  OPEN = 'open',
  IN_REVIEW = 'in_review',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

export const SUPPORT_CASE_FINAL_STATUSES = [
  SupportCaseStatus.RESOLVED,
  SupportCaseStatus.REJECTED,
] as const;

export type SupportCaseFinalStatus =
  (typeof SUPPORT_CASE_FINAL_STATUSES)[number];

export interface VoucherProviderIntent {
  readonly attemptId: string;
  readonly customerDueVnd: number;
  readonly reservedAt: Date;
  readonly expiresAt: Date;
  readonly initiatedAt: Date;
}

export type VoucherProviderOutcome =
  | { readonly terminal: 'PENDING' }
  | {
      readonly terminal: 'PAID' | 'FAILED';
      /** Must be set only after server-side VNPay signature or query-DR verification. */
      readonly signatureVerified: boolean;
      readonly attemptId: string;
      readonly amountVnd: number;
      readonly providerPaidAt: Date | null;
    };

export type VoucherProviderDecision = 'KEEP_PENDING' | 'SETTLE' | 'RELEASE' | 'QUARANTINE';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * F1 decision over an already verified immutable intent and normalized provider
 * evidence. QUARANTINE requires reconciliation or refund; it never authorizes
 * voucher redemption or an additional customer charge. This pure helper does
 * not verify a VNPay signature, update a hold, or settle money by itself.
 */
export function classifyVoucherProviderOutcome(
  intent: VoucherProviderIntent,
  evidence: VoucherProviderOutcome,
  observedAt: Date,
): VoucherProviderDecision {
  if (!intent || !evidence || !validDate(observedAt) ||
      !validDate(intent.reservedAt) || !validDate(intent.expiresAt) ||
      !validDate(intent.initiatedAt) ||
      !Number.isSafeInteger(intent.customerDueVnd) || intent.customerDueVnd <= 0 ||
      typeof intent.attemptId !== 'string' || intent.attemptId.length === 0 ||
      intent.expiresAt.getTime() - intent.reservedAt.getTime() !== FIFTEEN_MINUTES_MS ||
      intent.initiatedAt < intent.reservedAt || intent.initiatedAt >= intent.expiresAt ||
      intent.initiatedAt > observedAt) {
    return 'QUARANTINE';
  }
  if (evidence.terminal === 'PENDING') return 'KEEP_PENDING';
  if ((evidence.terminal !== 'PAID' && evidence.terminal !== 'FAILED') ||
      evidence.signatureVerified !== true || evidence.attemptId !== intent.attemptId ||
      evidence.amountVnd !== intent.customerDueVnd) {
    return 'QUARANTINE';
  }
  if (evidence.terminal === 'FAILED') {
    return evidence.providerPaidAt === null ? 'RELEASE' : 'QUARANTINE';
  }
  if (!validDate(evidence.providerPaidAt) || evidence.providerPaidAt < intent.initiatedAt ||
      evidence.providerPaidAt >= intent.expiresAt || evidence.providerPaidAt > observedAt) {
    return 'QUARANTINE';
  }
  return 'SETTLE';
}

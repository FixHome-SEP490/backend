import { verifySignature } from '../finance/vnpay/vnpay.util';
import {
  classifyVoucherProviderOutcome,
  type VoucherProviderDecision,
  type VoucherProviderIntent,
} from './voucher-provider-decision';

const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Parse VNPay's signed yyyyMMddHHmmss in Vietnam time; reject calendar normalization. */
export function parseVnpayPaidAt(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{14}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return null;
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const local = new Date(localMs);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month ||
      local.getUTCDate() !== day || local.getUTCHours() !== hour ||
      local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return null;
  return new Date(localMs - ICT_OFFSET_MS);
}

export interface SignedVoucherVnpayResult {
  readonly decision: VoucherProviderDecision;
  readonly providerReference: string | null;
  readonly providerPaidAt: Date | null;
}

const QUARANTINE: SignedVoucherVnpayResult = Object.freeze({
  decision: 'QUARANTINE', providerReference: null, providerPaidAt: null,
});

/**
 * Only a server-held VNPay secret and immutable attempt can authorize F1 evidence.
 * A missing signed PayDate is insufficient for a successful funded payment, even
 * when the IPN itself arrived with a valid HMAC. This is not a settlement writer.
 */
export function evaluateSignedVoucherVnpayCallback(
  intent: VoucherProviderIntent & { readonly merchantCode: string },
  query: Record<string, string>,
  hashSecret: string,
  observedAt: Date,
): SignedVoucherVnpayResult {
  if (!intent || !query || typeof hashSecret !== 'string' || !hashSecret ||
      !verifySignature(query, hashSecret) ||
      !Number.isSafeInteger(intent.customerDueVnd) || intent.customerDueVnd <= 0 ||
      query.vnp_TxnRef !== intent.attemptId ||
      typeof intent.merchantCode !== 'string' || !intent.merchantCode ||
      query.vnp_TmnCode !== intent.merchantCode ||
      (query.vnp_CurrCode !== undefined && query.vnp_CurrCode !== 'VND') ||
      typeof query.vnp_Amount !== 'string' || !/^[1-9]\d*$/.test(query.vnp_Amount) ||
      BigInt(query.vnp_Amount) !== BigInt(intent.customerDueVnd) * 100n ||
      !/^\d{2}$/.test(query.vnp_ResponseCode ?? '') ||
      !/^\d{2}$/.test(query.vnp_TransactionStatus ?? '')) {
    return QUARANTINE;
  }
  const paidAt = parseVnpayPaidAt(query.vnp_PayDate);
  if ((query.vnp_ResponseCode === '00') !== (query.vnp_TransactionStatus === '00')) {
    return QUARANTINE;
  }
  const paid = query.vnp_ResponseCode === '00' && query.vnp_TransactionStatus === '00';
  // VNPay v2.1.0: 01 is unfinished; 04/05/06/07/09 are reversal,
  // refund processing, suspected fraud or refused return, not no-money proof.
  // https://sandbox.vnpayment.vn/apis/docs/bang-ma-loi/
  if (!paid && query.vnp_PayDate === undefined &&
      query.vnp_TransactionStatus === '01' && query.vnp_ResponseCode !== '07') {
    return Object.freeze({
      decision: classifyVoucherProviderOutcome(intent, { terminal: 'PENDING' }, observedAt),
      providerReference: null, providerPaidAt: null,
    });
  }
  const noFundsResponses = ['09', '10', '11', '12', '13', '24', '51', '65', '75', '79'];
  if (!paid && (query.vnp_TransactionStatus !== '02' ||
      !noFundsResponses.includes(query.vnp_ResponseCode))) return QUARANTINE;
  if (paid && (!paidAt || typeof query.vnp_TransactionNo !== 'string' ||
      query.vnp_TransactionNo.length === 0 || query.vnp_TransactionNo.length > 255)) {
    return QUARANTINE;
  }
  // A failed response carrying any pay-time field is contradictory, including
  // an invalid date. It requires manual provider reconciliation.
  if (!paid && query.vnp_PayDate !== undefined) return Object.freeze({
    decision: 'QUARANTINE',
    providerReference: typeof query.vnp_TransactionNo === 'string' &&
      query.vnp_TransactionNo.length > 0 && query.vnp_TransactionNo.length <= 255
      ? query.vnp_TransactionNo : null,
    providerPaidAt: paidAt,
  });
  const decision = classifyVoucherProviderOutcome(intent, {
    terminal: paid ? 'PAID' : 'FAILED',
    signatureVerified: true,
    attemptId: query.vnp_TxnRef,
    amountVnd: intent.customerDueVnd,
    providerPaidAt: paidAt,
  }, observedAt);
  return Object.freeze({
    decision,
    providerReference: paid ? query.vnp_TransactionNo : null,
    providerPaidAt: paid ? paidAt : null,
  });
}

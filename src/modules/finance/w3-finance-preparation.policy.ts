import { createHash } from 'node:crypto';
import { assessOrderShippingLaborBudget } from './order-shipping-labor-budget.policy';
import { calculateShippingShares } from './shipping-finance.policy';

/** Hypothetical facts ONLY. No W3 attester/category/courier/funding adapter is authorized.
 * Never accept these as evidence on a live endpoint. No funds or payable are created. */
export interface W3DeductionAttestation {
  serviceOrderId: string;
  commissionFingerprint: string;
  revision: number;
  verification: 'SIMULATED_AUTHORIZED_VERIFIED';
  actorId: string;
  authorityRef: string;
  evidenceRef: string;
  explicitZero: boolean;
  entries: readonly {
    entryId: string;
    categoryRef: string;
    amount: number;
    evidenceRef: string;
  }[];
}
interface Commission {
  serviceOrderId: string;
  laborTotal: number;
  commissionAmount: number;
  fingerprint: string;
}
type DispatchState = 'BEFORE_DISPATCH' | 'DISPATCHED' | 'UNKNOWN';
export type W3CommitmentCommand = {
  commandId: string;
  expectedVersion: number;
  partRequestId: string;
  quoteVersion: number;
  evidenceRef: string;
} & (
  | { kind: 'COMMIT'; shippingFee: number }
  | { kind: 'RELEASE'; dispatchState: DispatchState }
);

const fail = (reason: string): never => {
  throw new Error(`W3_PREPARATION_${reason}`);
};
function exact(value: object, keys: string[]) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value'),
    )
  )
    fail('INVALID_SHAPE');
}
function ref(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$/.test(value)
  )
    fail('REFERENCE_REQUIRED');
  return value;
}
function vnd(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INTEGER');
  return BigInt(value);
}
function positive(value: number) {
  if (vnd(value) === 0n) fail('POSITIVE_VERSION_REQUIRED');
}
function checked(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('AMOUNT_OUT_OF_RANGE');
  return Number(value);
}
function dispatch(value: DispatchState) {
  if (!['BEFORE_DISPATCH', 'DISPATCHED', 'UNKNOWN'].includes(value))
    fail('INVALID_DISPATCH_STATE');
}
function deductionTotal(
  c: Commission,
  d: W3DeductionAttestation | null,
): number {
  if (!d) return fail('DEDUCTION_ATTESTATION_REQUIRED');
  exact(d, [
    'serviceOrderId',
    'commissionFingerprint',
    'revision',
    'verification',
    'actorId',
    'authorityRef',
    'evidenceRef',
    'explicitZero',
    'entries',
  ]);
  if (
    d.serviceOrderId !== c.serviceOrderId ||
    d.commissionFingerprint !== c.fingerprint ||
    d.verification !== 'SIMULATED_AUTHORIZED_VERIFIED'
  )
    fail('DEDUCTION_AUTHORITY_REQUIRED');
  positive(d.revision);
  ref(d.actorId);
  ref(d.authorityRef);
  ref(d.evidenceRef);
  if (!Array.isArray(d.entries)) fail('INVALID_DEDUCTION_LEDGER');
  let total = 0n;
  const seen = new Set<string>();
  for (const e of d.entries) {
    exact(e, ['entryId', 'categoryRef', 'amount', 'evidenceRef']);
    ref(e.entryId);
    ref(e.categoryRef);
    ref(e.evidenceRef);
    if (seen.has(e.entryId) || vnd(e.amount) === 0n)
      fail('INVALID_DEDUCTION_ENTRY');
    seen.add(e.entryId);
    total += vnd(e.amount);
  }
  if (d.explicitZero !== (d.entries.length === 0))
    fail('EXPLICIT_ZERO_STATEMENT_REQUIRED');
  return checked(total);
}

/** Whole-order hypothetical journal. Exact retries are noops; new commands use order CAS.
 * Future persistent writers must derive completeness under the order lock, authorize D,
 * and keep evidence-backed release history. No runtime caller, no live mutation. */
export function simulateW3Commitments(
  c: Commission,
  d: W3DeductionAttestation | null,
  commands: readonly W3CommitmentCommand[],
) {
  exact(c, ['serviceOrderId', 'laborTotal', 'commissionAmount', 'fingerprint']);
  ref(c.serviceOrderId);
  ref(c.fingerprint);
  vnd(c.laborTotal);
  vnd(c.commissionAmount);
  const deductions = deductionTotal(c, d);
  if (!Array.isArray(commands)) fail('JOURNAL_REQUIRED');
  const active = new Map<
    string,
    Extract<W3CommitmentCommand, { kind: 'COMMIT' }>
  >();
  const latestQuote = new Map<string, number>();
  const receipts = new Map<string, string>();
  let version = 0;
  const assess = () =>
    assessOrderShippingLaborBudget({
      version: 'W3_ORDER_SHIPPING_LABOR_BUDGET_V1',
      serviceOrderId: c.serviceOrderId,
      laborTotal: c.laborTotal,
      commissionAmount: c.commissionAmount,
      knownApprovedDeductions: deductions,
      deliveryRequestIds: [...active.keys()],
      deliveries: [...active.values()].map((v) => ({
        serviceOrderId: c.serviceOrderId,
        partRequestId: v.partRequestId,
        quoteVersion: v.quoteVersion,
        shippingPolicyVersion: 'W3_70_30_V1',
        shippingFee: v.shippingFee,
        ...calculateShippingShares(v.shippingFee, 'W3_70_30_V1'),
      })),
    });
  for (const command of commands) {
    const keys = [
      'commandId',
      'expectedVersion',
      'partRequestId',
      'quoteVersion',
      'evidenceRef',
      'kind',
      command?.kind === 'COMMIT' ? 'shippingFee' : 'dispatchState',
    ];
    exact(command, keys);
    ref(command.commandId);
    ref(command.partRequestId);
    ref(command.evidenceRef);
    positive(command.quoteVersion);
    vnd(command.expectedVersion);
    if (!['COMMIT', 'RELEASE'].includes(command.kind)) fail('INVALID_COMMAND');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(keys.map((k) => command[k])))
      .digest('hex');
    if (receipts.has(command.commandId)) {
      if (receipts.get(command.commandId) !== fingerprint)
        fail('REPLAY_CONFLICT');
      continue;
    }
    if (command.expectedVersion !== version) fail('CAS_CONFLICT');
    if (command.kind === 'COMMIT') {
      if (vnd(command.shippingFee) === 0n) fail('POSITIVE_SHIPPING_REQUIRED');
      if (active.has(command.partRequestId)) fail('COMMITMENT_EXISTS');
      if (command.quoteVersion <= (latestQuote.get(command.partRequestId) ?? 0))
        fail('QUOTE_MISMATCH');
      active.set(command.partRequestId, command);
      latestQuote.set(command.partRequestId, command.quoteVersion);
    } else {
      dispatch(command.dispatchState);
      if (command.dispatchState !== 'BEFORE_DISPATCH')
        fail('MANUAL_COURIER_REVIEW');
      const prior = active.get(command.partRequestId);
      if (!prior) fail('COMMITMENT_REQUIRED');
      if (prior.quoteVersion !== command.quoteVersion) fail('QUOTE_MISMATCH');
      active.delete(command.partRequestId);
    }
    assess(); // Temporary overcommit followed by a release must also fail.
    receipts.set(command.commandId, fingerprint);
    version++;
  }
  const budget = assess();
  return Object.freeze({
    version,
    customerShippingShare: budget.customerShippingShare,
    technicianShippingShare: budget.technicianShippingShare,
    netLabor: budget.netLaborAfterShipping,
    deductions,
    financialExecution: 'BLOCKED' as const,
    mode: 'SIMULATION_ONLY' as const,
  });
}

export function classifyW3Actual(input: {
  approvedCeiling: number;
  quoteCeiling: number;
  actual: number;
  quoteFingerprint: string;
  customerConsentFingerprint: string | null;
  technicianConsentFingerprint: string | null;
  evidenceRef: string;
  verification: 'SIMULATED_COURIER_VERIFIED' | 'MANUAL_RECORD';
}) {
  exact(input, [
    'approvedCeiling',
    'quoteCeiling',
    'actual',
    'quoteFingerprint',
    'customerConsentFingerprint',
    'technicianConsentFingerprint',
    'evidenceRef',
    'verification',
  ]);
  vnd(input.approvedCeiling);
  vnd(input.quoteCeiling);
  vnd(input.actual);
  ref(input.quoteFingerprint);
  ref(input.evidenceRef);
  if (
    !['SIMULATED_COURIER_VERIFIED', 'MANUAL_RECORD'].includes(
      input.verification,
    )
  )
    fail('INVALID_VERIFICATION');
  const reason =
    input.quoteCeiling > input.approvedCeiling ||
    input.actual > input.approvedCeiling ||
    input.actual > input.quoteCeiling ||
    input.customerConsentFingerprint !== input.quoteFingerprint ||
    input.technicianConsentFingerprint !== input.quoteFingerprint
      ? 'REVISE_RENEW_BOTH_CONSENTS'
      : input.verification !== 'SIMULATED_COURIER_VERIFIED'
        ? 'COURIER_VERIFICATION_REQUIRED'
        : 'WITHIN_APPROVED_CEILING';
  const eligible = reason === 'WITHIN_APPROVED_CEILING';
  const shares = eligible
    ? calculateShippingShares(input.actual, 'W3_70_30_V1')
    : null;
  return Object.freeze({
    reason,
    courierActual: eligible ? input.actual : null,
    customerShippingShare: shares?.customerShippingShare ?? null,
    technicianShippingShare: shares?.technicianShippingShare ?? null,
    financialExecution: 'BLOCKED' as const,
    mode: 'SIMULATION_ONLY' as const,
  });
}

interface Funding {
  paymentRef: string;
  rail: 'WALLET' | 'VNPAY' | 'CASH';
  fundedAmount: number;
  refundedAmount: number;
  verification: 'SIMULATED_VERIFIED_FUNDING';
  evidenceRef: string;
}
export function classifyW3Cancellation(input: {
  dispatchState: DispatchState;
  courierEvidenceRef: string | null;
  funding: readonly Funding[] | null;
}) {
  exact(input, ['dispatchState', 'courierEvidenceRef', 'funding']);
  dispatch(input.dispatchState);
  const blocked = {
    refundExecution: 'BLOCKED' as const,
    mode: 'SIMULATION_ONLY' as const,
  };
  if (input.dispatchState !== 'BEFORE_DISPATCH')
    return Object.freeze({
      ...blocked,
      reason: 'MANUAL_COURIER_REVIEW',
      refundable: [],
    });
  if (!input.courierEvidenceRef) return fail('PRE_DISPATCH_EVIDENCE_REQUIRED');
  ref(input.courierEvidenceRef);
  if (
    input.funding === null ||
    (Array.isArray(input.funding) && !input.funding.length)
  )
    return Object.freeze({
      ...blocked,
      reason: 'FUNDING_SOURCE_REQUIRED',
      refundable: [],
    });
  if (!Array.isArray(input.funding)) return fail('INVALID_FUNDING');
  const seen = new Set<string>();
  const refundable: {
    paymentRef: string;
    rail: Funding['rail'];
    amount: number;
  }[] = [];
  for (const f of input.funding) {
    exact(f, [
      'paymentRef',
      'rail',
      'fundedAmount',
      'refundedAmount',
      'verification',
      'evidenceRef',
    ]);
    ref(f.paymentRef);
    ref(f.evidenceRef);
    if (
      seen.has(f.paymentRef) ||
      !['WALLET', 'VNPAY', 'CASH'].includes(f.rail) ||
      f.verification !== 'SIMULATED_VERIFIED_FUNDING'
    )
      fail('INVALID_FUNDING');
    seen.add(f.paymentRef);
    const amount = checked(vnd(f.fundedAmount) - vnd(f.refundedAmount));
    if (amount)
      refundable.push(
        Object.freeze({ paymentRef: f.paymentRef, rail: f.rail, amount }),
      );
  }
  return Object.freeze({
    ...blocked,
    reason: refundable.length
      ? 'ORIGINAL_RAIL_REVIEW_REQUIRED'
      : 'NO_REMAINING_FUNDED_AMOUNT',
    refundable: Object.freeze(refundable),
  });
}

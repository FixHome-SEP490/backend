import { createHash } from 'node:crypto';

/** Proposed operating parameters only: no fee schedule, defaults, tax or ledger rules. */
export interface W3DeliveryPolicyParameters {
  readonly feeCeilingVnd: number;
  readonly proposalReviewAfterMinutes: number;
  readonly courierEvidenceReviewAfterMinutes: number;
}

export interface W3DeliveryPolicySnapshot {
  readonly kind: 'W3_DELIVERY_OPERATING_POLICY_V1';
  readonly policyId: string;
  /** Content version, distinct from lifecycle revision and per-order proposal version. */
  readonly version: number;
  readonly parameters: W3DeliveryPolicyParameters;
  /** Content identity only; neither a signature nor authenticated approval evidence. */
  readonly fingerprint: string;
}

export type W3DeliveryPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export interface W3DeliveryPolicyState {
  readonly mode: 'NON_EXECUTABLE_PREVIEW';
  readonly financialExecution: 'BLOCKED';
  readonly status: W3DeliveryPolicyStatus;
  readonly revision: number;
  readonly policy: W3DeliveryPolicySnapshot;
}

export interface W3DeliveryPolicyGateEvidence {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyFingerprint: string;
  readonly legal: W3DeliveryPolicyGate;
  readonly accounting: W3DeliveryPolicyGate;
  readonly warehouse: W3DeliveryPolicyGate;
  readonly courier: W3DeliveryPolicyGate;
}
export interface W3DeliveryPolicyGate {
  readonly status: 'VERIFIED' | 'UNKNOWN' | 'STALE' | 'REJECTED';
  readonly evidenceRef: string | null;
}
export type W3DeliveryPolicyBlocker =
  | 'LEGAL_UNVERIFIED'
  | 'ACCOUNTING_UNVERIFIED'
  | 'WAREHOUSE_UNVERIFIED'
  | 'COURIER_UNVERIFIED'
  | 'FINANCIAL_CUTOVER_CLOSED';

const gates = ['legal', 'accounting', 'warehouse', 'courier'] as const;
const gateBlockers = [
  'LEGAL_UNVERIFIED',
  'ACCOUNTING_UNVERIFIED',
  'WAREHOUSE_UNVERIFIED',
  'COURIER_UNVERIFIED',
] as const;
const parameterKeys = [
  'feeCeilingVnd',
  'proposalReviewAfterMinutes',
  'courierEvidenceReviewAfterMinutes',
] as const;
const fail = (code: string): never => {
  throw new Error(`W3_DELIVERY_POLICY_${code}`);
};

function shape(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(
      (key) => descriptors[key]?.enumerable && 'value' in descriptors[key],
    )
  );
}

function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_INTEGER');
  return value;
}
function next(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) fail('INTEGER_OVERFLOW');
  return integer(value + 1, 1);
}
function reference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_/-]{0,255}$/.test(value)
  );
}

function snapshot(
  policyId: string,
  version: number,
  parameters: W3DeliveryPolicyParameters,
): W3DeliveryPolicySnapshot {
  if (!reference(policyId)) fail('INVALID_ID');
  integer(version, 1);
  if (!shape(parameters, parameterKeys)) fail('INVALID_SHAPE');
  const content = {
    kind: 'W3_DELIVERY_OPERATING_POLICY_V1' as const,
    policyId,
    version,
    parameters: Object.freeze({
      feeCeilingVnd: integer(parameters.feeCeilingVnd),
      proposalReviewAfterMinutes: integer(
        parameters.proposalReviewAfterMinutes,
      ),
      courierEvidenceReviewAfterMinutes: integer(
        parameters.courierEvidenceReviewAfterMinutes,
      ),
    }),
  };
  return Object.freeze({
    ...content,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(content))
      .digest('hex'),
  });
}

function validate(state: W3DeliveryPolicyState): W3DeliveryPolicySnapshot {
  if (
    !shape(state, [
      'mode',
      'financialExecution',
      'status',
      'revision',
      'policy',
    ]) ||
    state.mode !== 'NON_EXECUTABLE_PREVIEW' ||
    state.financialExecution !== 'BLOCKED' ||
    !['DRAFT', 'ACTIVE', 'RETIRED'].includes(state.status)
  )
    fail('INVALID_STATE');
  integer(state.revision, 1);
  const policy = state.policy;
  if (
    !shape(policy, [
      'kind',
      'policyId',
      'version',
      'parameters',
      'fingerprint',
    ]) ||
    policy.kind !== 'W3_DELIVERY_OPERATING_POLICY_V1'
  )
    fail('INVALID_STATE');
  const normalized = snapshot(
    policy.policyId,
    policy.version,
    policy.parameters,
  );
  if (
    normalized.fingerprint !== policy.fingerprint ||
    state.revision < policy.version
  )
    fail('SNAPSHOT_MISMATCH');
  return normalized;
}

function stateOf(
  policy: W3DeliveryPolicySnapshot,
  status: W3DeliveryPolicyStatus,
  revision: number,
): W3DeliveryPolicyState {
  return Object.freeze({
    mode: 'NON_EXECUTABLE_PREVIEW',
    financialExecution: 'BLOCKED',
    status,
    revision,
    policy,
  });
}

/** Pure, unmounted foundation. Does not write SystemConfig or authorize an Admin. */
export function createW3DeliveryPolicyDraft(
  policyId: string,
  parameters: W3DeliveryPolicyParameters,
): W3DeliveryPolicyState {
  return stateOf(snapshot(policyId, 1, parameters), 'DRAFT', 1);
}

/** Copy-on-write content revision; old policy/proposal snapshots remain historical. */
export function reviseW3DeliveryPolicyDraft(
  state: W3DeliveryPolicyState,
  parameters: W3DeliveryPolicyParameters,
  expectedRevision: number,
): W3DeliveryPolicyState {
  const current = validate(state);
  integer(expectedRevision, 1);
  if (expectedRevision !== state.revision) fail('REVISION_CONFLICT');
  if (state.status === 'RETIRED') fail('INVALID_TRANSITION');
  return stateOf(
    snapshot(current.policyId, next(current.version), parameters),
    'DRAFT',
    next(state.revision),
  );
}

/** Evidence is hypothetical input to a model, never trusted verification from a client.
 * Missing/malformed/stale/mismatched evidence fails closed. Even all four gates cannot
 * open finance: shipping approval, aggregate labor, rounding and release remain unresolved. */
export function assessW3DeliveryPolicyGates(
  state: W3DeliveryPolicyState,
  evidence?: unknown,
) {
  const policy = validate(state);
  const bound =
    shape(evidence, [
      'policyId',
      'policyVersion',
      'policyFingerprint',
      ...gates,
    ]) &&
    evidence.policyId === policy.policyId &&
    evidence.policyVersion === policy.version &&
    evidence.policyFingerprint === policy.fingerprint;
  const blockers: W3DeliveryPolicyBlocker[] = [];
  gates.forEach((key, index) => {
    const gate = bound ? evidence[key] : undefined;
    if (
      !shape(gate, ['status', 'evidenceRef']) ||
      gate.status !== 'VERIFIED' ||
      !reference(gate.evidenceRef)
    )
      blockers.push(gateBlockers[index]);
  });
  blockers.push('FINANCIAL_CUTOVER_CLOSED');
  return Object.freeze({
    mode: 'NON_EXECUTABLE_PREVIEW' as const,
    financialExecution: 'BLOCKED' as const,
    blockers: Object.freeze(blockers),
  });
}

/** Lifecycle SIMULATION ONLY. ACTIVE describes a hypothetical state, never an effective
 * runtime policy. There is intentionally no activation adapter, persistence or route. */
export function simulateW3DeliveryPolicyTransition(
  state: W3DeliveryPolicyState,
  target: 'ACTIVE' | 'RETIRED',
  expectedRevision: number,
  evidence?: unknown,
): W3DeliveryPolicyState {
  const policy = validate(state);
  integer(expectedRevision, 1);
  if (expectedRevision !== state.revision) fail('REVISION_CONFLICT');
  if (!(
    (state.status === 'DRAFT' &&
      (target === 'ACTIVE' || target === 'RETIRED')) ||
    (state.status === 'ACTIVE' && target === 'RETIRED')
  ))
    fail('INVALID_TRANSITION');
  if (
    target === 'ACTIVE' &&
    assessW3DeliveryPolicyGates(state, evidence).blockers.length !== 1
  )
    fail('GATES_BLOCKED');
  return stateOf(policy, target, next(state.revision));
}

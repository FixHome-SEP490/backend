import { calculateShippingShares } from '../finance/shipping-finance.policy';
import {
  assessW3DeliveryPolicyGates,
  W3DeliveryPolicySnapshot,
  W3DeliveryPolicyState,
} from './w3-delivery-policy';

/** What-if input only; no order, shipping approval, budget or provider facts are resolved. */
export interface W3DeliveryImpactSample {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly shippingFeeVnd: number;
  readonly proposalAgeMinutes: number;
  /** null means absent/unknown, never age zero or reviewed evidence. */
  readonly courierEvidenceAgeMinutes: number | null;
}
export interface W3DeliveryProposalPreview extends W3DeliveryImpactSample {
  readonly policySnapshot: W3DeliveryPolicySnapshot;
  readonly customerShippingShare: number;
  readonly technicianShippingShare: number;
  readonly aboveFeeCeiling: boolean;
  readonly proposalReviewDue: boolean;
  readonly courierEvidenceReviewDue: boolean | null;
}

const fail = (code: string): never => {
  throw new Error(`W3_DELIVERY_POLICY_${code}`);
};
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

function validateSample(sample: W3DeliveryImpactSample): void {
  const keys = [
    'proposalId',
    'proposalVersion',
    'shippingFeeVnd',
    'proposalAgeMinutes',
    'courierEvidenceAgeMinutes',
  ];
  if (
    !sample ||
    typeof sample !== 'object' ||
    Array.isArray(sample) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(sample)) ||
    Reflect.ownKeys(sample).length !== keys.length
  )
    fail('INVALID_SAMPLE');
  const descriptors = Object.getOwnPropertyDescriptors(sample);
  if (
    !keys.every(
      (key) => descriptors[key]?.enumerable && 'value' in descriptors[key],
    )
  )
    fail('INVALID_SAMPLE');
  if (
    typeof sample.proposalId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_/-]{0,255}$/.test(sample.proposalId) ||
    !integer(sample.proposalVersion, 1) ||
    !integer(sample.shippingFeeVnd) ||
    !integer(sample.proposalAgeMinutes) ||
    (sample.courierEvidenceAgeMinutes !== null &&
      !integer(sample.courierEvidenceAgeMinutes))
  )
    fail('INVALID_SAMPLE');
}

function checked(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('TOTAL_OVERFLOW');
  return Number(value);
}

/** Pure, detached immutable impact preview. Does not create/revise real proposals or
 * consents. A ceiling is a review limit, never a generated fee or a financial entitlement.
 * Thresholds flag review only; they do not expire consent, dispatch or trigger a job. */
export function previewW3DeliveryPolicyImpact(
  state: W3DeliveryPolicyState,
  samples: readonly W3DeliveryImpactSample[],
) {
  // Validate the full state and preserve unresolved gates even for zero/empty previews.
  const assessment = assessW3DeliveryPolicyGates(state);
  if (!Array.isArray(samples)) fail('INVALID_SAMPLE');
  const policySnapshot: W3DeliveryPolicySnapshot = Object.freeze({
    ...state.policy,
    parameters: Object.freeze({ ...state.policy.parameters }),
  });
  const parameters = policySnapshot.parameters;
  const identities = new Set<string>();
  let shipping = 0n;
  let customer = 0n;
  let technician = 0n;
  let aboveFeeCeiling = 0;
  let proposalReviewDue = 0;
  let courierEvidenceReviewDue = 0;
  const proposals = Array.from(samples, (sample): W3DeliveryProposalPreview => {
    validateSample(sample);
    if (identities.has(sample.proposalId)) fail('DUPLICATE_PROPOSAL');
    identities.add(sample.proposalId);
    const shares = calculateShippingShares(
      sample.shippingFeeVnd,
      'W3_70_30_V1',
    );
    shipping += BigInt(sample.shippingFeeVnd);
    customer += BigInt(shares.customerShippingShare);
    technician += BigInt(shares.technicianShippingShare);
    const feeExceeded = sample.shippingFeeVnd > parameters.feeCeilingVnd;
    const proposalDue =
      sample.proposalAgeMinutes >= parameters.proposalReviewAfterMinutes;
    const courierDue =
      sample.courierEvidenceAgeMinutes === null
        ? null
        : sample.courierEvidenceAgeMinutes >=
          parameters.courierEvidenceReviewAfterMinutes;
    aboveFeeCeiling += Number(feeExceeded);
    proposalReviewDue += Number(proposalDue);
    courierEvidenceReviewDue += Number(courierDue === true);
    return Object.freeze({
      ...sample,
      policySnapshot,
      ...shares,
      aboveFeeCeiling: feeExceeded,
      proposalReviewDue: proposalDue,
      courierEvidenceReviewDue: courierDue,
    });
  });
  return Object.freeze({
    ...assessment,
    policyStatus: state.status,
    policyRevision: state.revision,
    proposals: Object.freeze(proposals),
    totals: Object.freeze({
      shippingFeeVnd: checked(shipping),
      customerShippingShare: checked(customer),
      technicianShippingShare: checked(technician),
    }),
    counts: Object.freeze({
      proposals: proposals.length,
      aboveFeeCeiling,
      proposalReviewDue,
      courierEvidenceReviewDue,
    }),
  });
}

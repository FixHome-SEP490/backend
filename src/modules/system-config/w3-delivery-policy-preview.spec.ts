import { describe, expect, it } from 'vitest';
import { assertShippingFinancialCutoverAllowed } from '../finance/invoice-shipping-snapshot';
import {
  createW3DeliveryPolicyDraft,
  reviseW3DeliveryPolicyDraft,
} from './w3-delivery-policy';
import { previewW3DeliveryPolicyImpact } from './w3-delivery-policy-preview';

const parameters = {
  feeCeilingVnd: 20_000,
  proposalReviewAfterMinutes: 30,
  courierEvidenceReviewAfterMinutes: 60,
};
const draft = () =>
  createW3DeliveryPolicyDraft('operating-policy', { ...parameters });
const sample = (overrides = {}) => ({
  proposalId: 'proposal-1',
  proposalVersion: 7,
  shippingFeeVnd: 20_000,
  proposalAgeMinutes: 29,
  courierEvidenceAgeMinutes: 60,
  ...overrides,
});

describe('inert policy impact preview', () => {
  it('binds a distinct proposal version and full policy snapshot with exact existing 70/30 shares', () => {
    const state = draft();
    const result = previewW3DeliveryPolicyImpact(state, [sample()]);
    expect(result).toMatchObject({
      mode: 'NON_EXECUTABLE_PREVIEW',
      financialExecution: 'BLOCKED',
      policyStatus: 'DRAFT',
      totals: {
        shippingFeeVnd: 20_000,
        customerShippingShare: 14_000,
        technicianShippingShare: 6_000,
      },
      counts: {
        proposals: 1,
        aboveFeeCeiling: 0,
        proposalReviewDue: 0,
        courierEvidenceReviewDue: 1,
      },
      proposals: [
        {
          proposalId: 'proposal-1',
          proposalVersion: 7,
          shippingFeeVnd: 20_000,
          customerShippingShare: 14_000,
          technicianShippingShare: 6_000,
          aboveFeeCeiling: false,
          proposalReviewDue: false,
          courierEvidenceReviewDue: true,
          policySnapshot: {
            policyId: 'operating-policy',
            version: 1,
            parameters,
          },
        },
      ],
    });
    expect(result.proposals[0].policySnapshot.fingerprint).toBe(
      state.policy.fingerprint,
    );
    expect(result.blockers).toContain('FINANCIAL_CUTOVER_CLOSED');
    expect(result.blockers).toContain('LEGAL_UNVERIFIED');
  });

  it('sums per-proposal rounded shares rather than rounding the aggregate', () => {
    const preview = previewW3DeliveryPolicyImpact(draft(), [
      sample({ shippingFeeVnd: 1 }),
      sample({ proposalId: 'proposal-2', shippingFeeVnd: 1 }),
    ]);
    expect(preview.totals).toEqual({
      shippingFeeVnd: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
    });
  });

  it('flags a fee above the configured ceiling without silently lowering it', () => {
    const preview = previewW3DeliveryPolicyImpact(draft(), [
      sample({ shippingFeeVnd: 20_001, proposalAgeMinutes: 30 }),
    ]);
    expect(preview.proposals[0]).toMatchObject({
      shippingFeeVnd: 20_001,
      aboveFeeCeiling: true,
      proposalReviewDue: true,
    });
    expect(preview.counts.aboveFeeCeiling).toBe(1);
    expect(preview.counts.proposalReviewDue).toBe(1);
    expect(preview.financialExecution).toBe('BLOCKED');
  });

  it('zero is explicit, has no auto-consent and does not remove missing gates', () => {
    const zero = createW3DeliveryPolicyDraft('policy-zero', {
      feeCeilingVnd: 0,
      proposalReviewAfterMinutes: 0,
      courierEvidenceReviewAfterMinutes: 0,
    });
    const preview = previewW3DeliveryPolicyImpact(zero, [
      sample({
        shippingFeeVnd: 0,
        proposalAgeMinutes: 0,
        courierEvidenceAgeMinutes: 0,
      }),
    ]);
    expect(preview.totals).toEqual({
      shippingFeeVnd: 0,
      customerShippingShare: 0,
      technicianShippingShare: 0,
    });
    expect(preview.counts).toEqual({
      proposals: 1,
      aboveFeeCeiling: 0,
      proposalReviewDue: 1,
      courierEvidenceReviewDue: 1,
    });
    expect(preview.blockers).toHaveLength(5);
  });

  it('does not assume evidence age when evidence is absent', () => {
    const preview = previewW3DeliveryPolicyImpact(draft(), [
      sample({ courierEvidenceAgeMinutes: null }),
    ]);
    expect(preview.proposals[0].courierEvidenceReviewDue).toBeNull();
    expect(preview.counts.courierEvidenceReviewDue).toBe(0);
    expect(preview.blockers).toContain('COURIER_UNVERIFIED');
  });

  it('retains historical proposal snapshots and freezes detached preview values', () => {
    const first = draft();
    const input = sample();
    const old = previewW3DeliveryPolicyImpact(first, [input]);
    input.shippingFeeVnd = 0;
    const revised = reviseW3DeliveryPolicyDraft(
      first,
      { ...parameters, feeCeilingVnd: 10_000 },
      1,
    );
    const next = previewW3DeliveryPolicyImpact(revised, [
      sample({ proposalVersion: 8 }),
    ]);
    expect(old.proposals[0]).toMatchObject({
      proposalVersion: 7,
      shippingFeeVnd: 20_000,
      policySnapshot: { version: 1, parameters: { feeCeilingVnd: 20_000 } },
    });
    expect(next.proposals[0]).toMatchObject({
      proposalVersion: 8,
      aboveFeeCeiling: true,
      policySnapshot: { version: 2 },
    });
    expect(old.proposals[0].policySnapshot.fingerprint).not.toBe(
      next.proposals[0].policySnapshot.fingerprint,
    );
    for (const value of [
      old,
      old.proposals,
      old.proposals[0],
      old.proposals[0].policySnapshot,
      old.proposals[0].policySnapshot.parameters,
      old.totals,
      old.counts,
      old.blockers,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(input)).toBe(false);
  });

  const invalid = [
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    1n,
    undefined,
    true,
  ];
  for (const field of [
    'shippingFeeVnd',
    'proposalVersion',
    'proposalAgeMinutes',
    'courierEvidenceAgeMinutes',
  ]) {
    it.each(invalid)(`rejects invalid ${field}: %s`, (value) => {
      expect(() =>
        previewW3DeliveryPolicyImpact(draft(), [sample({ [field]: value })]),
      ).toThrow('INVALID_SAMPLE');
    });
  }
  it.each(['shippingFeeVnd', 'proposalVersion', 'proposalAgeMinutes'])(
    'rejects null %s',
    (field) => {
      expect(() =>
        previewW3DeliveryPolicyImpact(draft(), [sample({ [field]: null })]),
      ).toThrow('INVALID_SAMPLE');
    },
  );
  it('rejects zero proposal version', () => {
    expect(() =>
      previewW3DeliveryPolicyImpact(draft(), [sample({ proposalVersion: 0 })]),
    ).toThrow('INVALID_SAMPLE');
  });
  it.each(['', '../id', 'a'.repeat(257), null, 1])(
    'rejects malformed proposal identity %s',
    (proposalId) => {
      expect(() =>
        previewW3DeliveryPolicyImpact(draft(), [sample({ proposalId })]),
      ).toThrow('INVALID_SAMPLE');
    },
  );
  it('rejects duplicate proposal identities even if their proposal versions differ', () => {
    expect(() =>
      previewW3DeliveryPolicyImpact(draft(), [
        sample(),
        sample({ proposalVersion: 8 }),
      ]),
    ).toThrow('DUPLICATE_PROPOSAL');
  });
  it.each([null, {}, [null], [sample({ activate: true })], Array(1)])(
    'rejects malformed sample collections %s',
    (input) => {
      expect(() =>
        previewW3DeliveryPolicyImpact(draft(), input as never),
      ).toThrow('INVALID_SAMPLE');
    },
  );
  it('allows empty impact without creating or activating a policy', () => {
    const preview = previewW3DeliveryPolicyImpact(draft(), []);
    expect(preview.proposals).toEqual([]);
    expect(preview.counts.proposals).toBe(0);
    expect(preview.totals).toEqual({
      shippingFeeVnd: 0,
      customerShippingShare: 0,
      technicianShippingShare: 0,
    });
    expect(preview.financialExecution).toBe('BLOCKED');
  });

  it('calculates the safe integer boundary exactly using BigInt intermediates', () => {
    const state = createW3DeliveryPolicyDraft('boundary', {
      ...parameters,
      feeCeilingVnd: Number.MAX_SAFE_INTEGER,
    });
    const preview = previewW3DeliveryPolicyImpact(state, [
      sample({ shippingFeeVnd: Number.MAX_SAFE_INTEGER }),
    ]);
    expect(preview.totals).toEqual({
      shippingFeeVnd: 9_007_199_254_740_991,
      customerShippingShare: 6_305_039_478_318_694,
      technicianShippingShare: 2_702_159_776_422_297,
    });
  });
  it('rejects aggregate overflow even when every individual amount is valid', () => {
    expect(() =>
      previewW3DeliveryPolicyImpact(draft(), [
        sample({ shippingFeeVnd: Number.MAX_SAFE_INTEGER }),
        sample({ proposalId: 'proposal-2', shippingFeeVnd: 1 }),
      ]),
    ).toThrow('TOTAL_OVERFLOW');
  });
  it('revalidates supplied policy snapshots before calculation', () => {
    const state = structuredClone(draft());
    (state.policy.parameters as { feeCeilingVnd: number }).feeCeilingVnd = 1;
    expect(() => previewW3DeliveryPolicyImpact(state, [sample()])).toThrow(
      'SNAPSHOT_MISMATCH',
    );
  });
  it('cannot authorize W3 finance through any generated preview or policy snapshot', () => {
    const preview = previewW3DeliveryPolicyImpact(draft(), [sample()]);
    const proposal = preview.proposals[0];
    expect(() =>
      assertShippingFinancialCutoverAllowed({
        shippingPolicyVersion: 'W3_70_30_V1',
        shippingFee: proposal.shippingFeeVnd,
        customerShippingShare: proposal.customerShippingShare,
        technicianShippingShare: proposal.technicianShippingShare,
      }),
    ).toThrow('Chính sách giao linh kiện chưa được mở thanh toán.');
  });
});

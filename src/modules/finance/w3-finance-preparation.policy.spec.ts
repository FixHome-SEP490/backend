import { describe, expect, it } from 'vitest';
import {
  simulateW3Commitments,
  classifyW3Actual,
  classifyW3Cancellation,
  type W3DeductionAttestation,
  type W3CommitmentCommand,
} from './w3-finance-preparation.policy';

const commission = {
  serviceOrderId: 'order-a',
  laborTotal: 100,
  commissionAmount: 10,
  fingerprint: 'frozen-source-a',
};
const deductions: W3DeductionAttestation = {
  serviceOrderId: 'order-a',
  commissionFingerprint: 'frozen-source-a',
  revision: 1,
  verification: 'SIMULATED_AUTHORIZED_VERIFIED',
  actorId: 'finance-fixture',
  authorityRef: 'hypothetical-mandate',
  evidenceRef: 'explicit-complete-zero-statement',
  explicitZero: true,
  entries: [],
};
const commit = (
  id: string,
  expectedVersion: number,
  shippingFee = 1,
): Extract<W3CommitmentCommand, { kind: 'COMMIT' }> => ({
  commandId: id,
  expectedVersion,
  kind: 'COMMIT',
  partRequestId: id,
  quoteVersion: 1,
  shippingFee,
  evidenceRef: `quote-${id}`,
});
const run = (
  commands: W3CommitmentCommand[],
  d: W3DeductionAttestation | null = deductions,
) => simulateW3Commitments(commission, d, commands);

describe('W3 preparatory simulations: no money authority', () => {
  it('aggregates two S=1 shipments as c=2,t=0 without reserving money', () => {
    expect(run([commit('a', 0), commit('b', 1)])).toMatchObject({
      version: 2,
      customerShippingShare: 2,
      technicianShippingShare: 0,
      netLabor: 90,
      financialExecution: 'BLOCKED',
      mode: 'SIMULATION_ONLY',
    });
  });
  it.each([
    null,
    { ...deductions, explicitZero: false },
    { ...deductions, actorId: '' },
    { ...deductions, authorityRef: '' },
    { ...deductions, evidenceRef: '' },
    { ...deductions, verification: 'MANUAL_RECORD' },
    { ...deductions, serviceOrderId: 'other' },
    { ...deductions, commissionFingerprint: 'stale' },
  ])('blocks absent, unverified or unscoped D (%j)', (d) => {
    expect(() => run([commit('a', 0)], d as W3DeductionAttestation)).toThrow();
  });
  it('accounts for evidence-backed positive D separately; never infers zero', () => {
    const d = {
      ...deductions,
      explicitZero: false,
      entries: [
        {
          entryId: 'd1',
          categoryRef: 'hypothetical-category',
          amount: 20,
          evidenceRef: 'deduction-proof',
        },
      ],
    };
    expect(run([commit('a', 0, 100)], d).netLabor).toBe(40);
    expect(() => run([], { ...d, explicitZero: true })).toThrow();
    expect(() =>
      run([], { ...d, entries: [...d.entries, ...d.entries] }),
    ).toThrow();
    expect(() =>
      run([], { ...d, entries: [{ ...d.entries[0], evidenceRef: '' }] }),
    ).toThrow();
  });
  it('blocks insufficient L-C-D-sum(t), without debt, clamp or subsidy', () => {
    expect(() => run([commit('a', 0, 200), commit('b', 1, 200)])).toThrow(
      'INSUFFICIENT_NET_LABOR',
    );
  });
  it('rejects zero-fee commitments; zero-fee operations retain their existing flow', () => {
    expect(() => run([commit('a', 0, 0)])).toThrow();
  });
  it('keeps exact replay idempotent and rejects changed payload, stale CAS and duplicate commitment', () => {
    const a = commit('a', 0, 20);
    expect(run([a, a]).version).toBe(1);
    expect(() => run([a, { ...a, shippingFee: 21 }])).toThrow(
      'REPLAY_CONFLICT',
    );
    expect(() => run([a, commit('b', 0)])).toThrow('CAS_CONFLICT');
    expect(() =>
      run([a, { ...a, commandId: 'new', expectedVersion: 1 }]),
    ).toThrow('COMMITMENT_EXISTS');
  });
  it('releases only an existing pre-dispatch commitment once, without refund execution', () => {
    const release: W3CommitmentCommand = {
      commandId: 'cancel-a',
      expectedVersion: 1,
      kind: 'RELEASE',
      partRequestId: 'a',
      quoteVersion: 1,
      dispatchState: 'BEFORE_DISPATCH',
      evidenceRef: 'pre-dispatch-cancel-proof',
    };
    expect(run([commit('a', 0, 100), release, release])).toMatchObject({
      version: 2,
      technicianShippingShare: 0,
      netLabor: 90,
    });
    expect(() =>
      run([commit('a', 0), { ...release, quoteVersion: 2 }]),
    ).toThrow('QUOTE_MISMATCH');
    expect(() =>
      run([
        commit('a', 0),
        release,
        { ...release, commandId: 'again', expectedVersion: 2 },
      ]),
    ).toThrow('COMMITMENT_REQUIRED');
    for (const dispatchState of ['DISPATCHED', 'UNKNOWN'] as const)
      expect(() =>
        run([commit('a', 0), { ...release, dispatchState }]),
      ).toThrow('MANUAL_COURIER_REVIEW');
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid VND %s',
    (shippingFee) => {
      expect(() => run([commit('a', 0, shippingFee as number)])).toThrow();
    },
  );
  it('rejects overflow and invalid deduction amounts', () => {
    expect(() =>
      run([], {
        ...deductions,
        explicitZero: false,
        entries: [
          { entryId: 'd', categoryRef: 'cat', amount: -1, evidenceRef: 'e' },
        ],
      }),
    ).toThrow();
    expect(() =>
      run([
        commit('a', 0, Number.MAX_SAFE_INTEGER),
        commit('b', 1, Number.MAX_SAFE_INTEGER),
      ]),
    ).toThrow();
  });
});

const actual = {
  approvedCeiling: 20,
  quoteCeiling: 20,
  actual: 15,
  quoteFingerprint: 'quote-v1',
  customerConsentFingerprint: 'quote-v1',
  technicianConsentFingerprint: 'quote-v1',
  evidenceRef: 'courier-actual',
  verification: 'SIMULATED_COURIER_VERIFIED' as const,
};
describe('W3 actual and cancel reason classification only', () => {
  it('uses genuine actual <= ceiling, full courier S and actual 70/30; never quote payable', () => {
    expect(classifyW3Actual(actual)).toMatchObject({
      reason: 'WITHIN_APPROVED_CEILING',
      courierActual: 15,
      customerShippingShare: 11,
      technicianShippingShare: 4,
      financialExecution: 'BLOCKED',
    });
    expect(classifyW3Actual({ ...actual, actual: 1 })).toMatchObject({
      customerShippingShare: 1,
      technicianShippingShare: 0,
    });
  });
  it('requires revision and BOTH renewed consents above ceiling or mismatched approval', () => {
    expect(classifyW3Actual({ ...actual, actual: 21 })).toMatchObject({
      reason: 'REVISE_RENEW_BOTH_CONSENTS',
      courierActual: null,
    });
    expect(
      classifyW3Actual({ ...actual, customerConsentFingerprint: 'quote-v0' })
        .reason,
    ).toBe('REVISE_RENEW_BOTH_CONSENTS');
    expect(
      classifyW3Actual({ ...actual, technicianConsentFingerprint: null })
        .reason,
    ).toBe('REVISE_RENEW_BOTH_CONSENTS');
    expect(
      classifyW3Actual({
        ...actual,
        approvedCeiling: 150,
        quoteCeiling: 101,
        actual: 120,
      }),
    ).toMatchObject({
      reason: 'REVISE_RENEW_BOTH_CONSENTS',
      courierActual: null,
    });
  });
  it('never upgrades manual actual evidence to courier verification', () => {
    expect(
      classifyW3Actual({ ...actual, verification: 'MANUAL_RECORD' }).reason,
    ).toBe('COURIER_VERIFICATION_REQUIRED');
    expect(() => classifyW3Actual({ ...actual, evidenceRef: '' })).toThrow();
  });
  const funded = {
    paymentRef: 'payment-a',
    rail: 'VNPAY' as const,
    fundedAmount: 14,
    refundedAmount: 4,
    verification: 'SIMULATED_VERIFIED_FUNDING' as const,
    evidenceRef: 'paid-allocation-proof',
  };
  it('classifies original-rail remaining actual funding without silently performing refunds', () => {
    expect(
      classifyW3Cancellation({
        dispatchState: 'BEFORE_DISPATCH',
        courierEvidenceRef: 'cancel-proof',
        funding: [funded],
      }),
    ).toMatchObject({
      reason: 'ORIGINAL_RAIL_REVIEW_REQUIRED',
      refundable: [{ paymentRef: 'payment-a', rail: 'VNPAY', amount: 10 }],
      refundExecution: 'BLOCKED',
    });
    expect(
      classifyW3Cancellation({
        dispatchState: 'BEFORE_DISPATCH',
        courierEvidenceRef: 'cancel-proof',
        funding: null,
      }).reason,
    ).toBe('FUNDING_SOURCE_REQUIRED');
  });
  it('after dispatch or unknown custody always requires manual review, even with paid evidence', () => {
    for (const dispatchState of ['DISPATCHED', 'UNKNOWN'] as const)
      expect(
        classifyW3Cancellation({
          dispatchState,
          courierEvidenceRef: null,
          funding: [funded],
        }),
      ).toMatchObject({
        reason: 'MANUAL_COURIER_REVIEW',
        refundable: [],
        refundExecution: 'BLOCKED',
      });
  });
  it('rejects duplicate funding, overrefund, unverified funding and zero inferred from empty records', () => {
    const classify = (funding: any) =>
      classifyW3Cancellation({
        dispatchState: 'BEFORE_DISPATCH',
        courierEvidenceRef: 'proof',
        funding,
      });
    expect(classify([]).reason).toBe('FUNDING_SOURCE_REQUIRED');
    expect(() => classify([funded, funded])).toThrow();
    expect(() => classify([{ ...funded, refundedAmount: 15 }])).toThrow();
    expect(() => classify([{ ...funded, verification: 'PENDING' }])).toThrow();
    expect(classify([{ ...funded, refundedAmount: 14 }])).toMatchObject({
      reason: 'NO_REMAINING_FUNDED_AMOUNT',
      refundable: [],
    });
  });
});

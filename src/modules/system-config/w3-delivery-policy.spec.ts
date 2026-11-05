import { describe, expect, it } from 'vitest';
import {
  assessW3DeliveryPolicyGates,
  createW3DeliveryPolicyDraft,
  reviseW3DeliveryPolicyDraft,
  simulateW3DeliveryPolicyTransition,
} from './w3-delivery-policy';

const parameters = () => ({
  feeCeilingVnd: 20_000,
  proposalReviewAfterMinutes: 30,
  courierEvidenceReviewAfterMinutes: 60,
});
const draft = () => createW3DeliveryPolicyDraft('policy-1', parameters());
const evidence = (state = draft()) => ({
  policyId: state.policy.policyId,
  policyVersion: state.policy.version,
  policyFingerprint: state.policy.fingerprint,
  legal: { status: 'VERIFIED', evidenceRef: 'legal-review-1' },
  accounting: { status: 'VERIFIED', evidenceRef: 'accounting-review-1' },
  warehouse: { status: 'VERIFIED', evidenceRef: 'delivery-warehouse-review-1' },
  courier: { status: 'VERIFIED', evidenceRef: 'courier-review-1' },
});

describe('inert W3 delivery operating policy', () => {
  it('creates an immutable Draft without freezing caller values or selecting defaults', () => {
    const input = parameters();
    const state = createW3DeliveryPolicyDraft('policy-1', input);
    input.feeCeilingVnd = 1;
    expect(state).toMatchObject({
      mode: 'NON_EXECUTABLE_PREVIEW',
      status: 'DRAFT',
      revision: 1,
      financialExecution: 'BLOCKED',
      policy: {
        policyId: 'policy-1',
        version: 1,
        parameters: { feeCeilingVnd: 20_000 },
      },
    });
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(state.policy.parameters)).toBe(true);
    expect(Object.isFrozen(state.policy)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
  });

  const invalid = [
    -1,
    0.1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '100',
    1n,
    null,
    undefined,
    true,
  ];
  for (const field of Object.keys(parameters())) {
    it.each(invalid)(`rejects invalid ${field}: %s`, (value) => {
      expect(() =>
        createW3DeliveryPolicyDraft('policy-1', {
          ...parameters(),
          [field]: value,
        } as never),
      ).toThrow('W3_DELIVERY_POLICY_INVALID_INTEGER');
    });
    it(`requires explicit ${field}`, () => {
      const input = parameters();
      delete input[field];
      expect(() => createW3DeliveryPolicyDraft('policy-1', input)).toThrow();
    });
  }

  it('accepts explicit zero and the safe integer boundary for every parameter', () => {
    for (const n of [0, Number.MAX_SAFE_INTEGER]) {
      const state = createW3DeliveryPolicyDraft('policy-1', {
        feeCeilingVnd: n,
        proposalReviewAfterMinutes: n,
        courierEvidenceReviewAfterMinutes: n,
      });
      expect(state.policy.parameters.feeCeilingVnd).toBe(n);
    }
  });

  it.each([null, [], {}, { ...parameters(), activate: true }])(
    'rejects malformed parameters %s',
    (input) => {
      expect(() =>
        createW3DeliveryPolicyDraft('policy-1', input as never),
      ).toThrow();
    },
  );
  it.each(['', ' policy', '../policy', 'a'.repeat(257), null])(
    'rejects invalid policy identity %s',
    (id) => {
      expect(() =>
        createW3DeliveryPolicyDraft(id as string, parameters()),
      ).toThrow();
    },
  );

  it('canonicalizes parameter order for content identity', () => {
    const reordered = {
      courierEvidenceReviewAfterMinutes: 60,
      feeCeilingVnd: 20_000,
      proposalReviewAfterMinutes: 30,
    };
    expect(
      createW3DeliveryPolicyDraft('policy-1', reordered).policy.fingerprint,
    ).toBe(draft().policy.fingerprint);
  });

  it('creates a new policy version even for an identical revision without rewriting old snapshots', () => {
    const first = draft();
    const second = reviseW3DeliveryPolicyDraft(first, parameters(), 1);
    expect(first.policy.version).toBe(1);
    expect(second).toMatchObject({
      status: 'DRAFT',
      revision: 2,
      policy: { version: 2 },
    });
    expect(second.policy.fingerprint).not.toBe(first.policy.fingerprint);
  });

  it('can branch a new Draft from simulated Active while preserving its parameters and status', () => {
    const first = draft();
    const active = simulateW3DeliveryPolicyTransition(
      first,
      'ACTIVE',
      1,
      evidence(first),
    );
    const next = reviseW3DeliveryPolicyDraft(
      active,
      { ...parameters(), feeCeilingVnd: 10_000 },
      2,
    );
    expect(active).toMatchObject({
      status: 'ACTIVE',
      revision: 2,
      policy: { version: 1 },
    });
    expect(next).toMatchObject({
      status: 'DRAFT',
      revision: 3,
      policy: { version: 2, parameters: { feeCeilingVnd: 10_000 } },
    });
    expect(active.policy.parameters.feeCeilingVnd).toBe(20_000);
  });

  it.each([0, 2, -1, 1.1, null, '1'])(
    'rejects stale or malformed expected revision %s',
    (revision) => {
      expect(() =>
        reviseW3DeliveryPolicyDraft(draft(), parameters(), revision as number),
      ).toThrow();
      expect(() =>
        simulateW3DeliveryPolicyTransition(
          draft(),
          'RETIRED',
          revision as number,
        ),
      ).toThrow();
    },
  );

  it.each(['DRAFT', 'ACTIVE'] as const)(
    'retires %s only in simulation and never revives it',
    (status) => {
      const first = draft();
      const current =
        status === 'ACTIVE'
          ? simulateW3DeliveryPolicyTransition(
              first,
              status,
              1,
              evidence(first),
            )
          : first;
      const retired = simulateW3DeliveryPolicyTransition(
        current,
        'RETIRED',
        current.revision,
      );
      expect(retired.financialExecution).toBe('BLOCKED');
      expect(() =>
        simulateW3DeliveryPolicyTransition(
          retired,
          'ACTIVE',
          retired.revision,
          evidence(retired),
        ),
      ).toThrow('INVALID_TRANSITION');
      expect(() =>
        simulateW3DeliveryPolicyTransition(
          retired,
          'RETIRED',
          retired.revision,
        ),
      ).toThrow('INVALID_TRANSITION');
      expect(() =>
        reviseW3DeliveryPolicyDraft(retired, parameters(), retired.revision),
      ).toThrow('INVALID_TRANSITION');
    },
  );

  it('does not support same-state activation, rollback to Draft or unknown transitions', () => {
    const first = draft();
    const active = simulateW3DeliveryPolicyTransition(
      first,
      'ACTIVE',
      1,
      evidence(first),
    );
    for (const target of ['DRAFT', 'LIVE', null]) {
      expect(() =>
        simulateW3DeliveryPolicyTransition(
          first,
          target as never,
          1,
          evidence(first),
        ),
      ).toThrow('INVALID_TRANSITION');
    }
    expect(() =>
      simulateW3DeliveryPolicyTransition(active, 'ACTIVE', 2, evidence(active)),
    ).toThrow('INVALID_TRANSITION');
  });

  it('lists every unresolved gate and never offers financial execution', () => {
    expect(assessW3DeliveryPolicyGates(draft())).toEqual({
      mode: 'NON_EXECUTABLE_PREVIEW',
      financialExecution: 'BLOCKED',
      blockers: [
        'LEGAL_UNVERIFIED',
        'ACCOUNTING_UNVERIFIED',
        'WAREHOUSE_UNVERIFIED',
        'COURIER_UNVERIFIED',
        'FINANCIAL_CUTOVER_CLOSED',
      ],
    });
    expect(() =>
      simulateW3DeliveryPolicyTransition(draft(), 'ACTIVE', 1),
    ).toThrow('GATES_BLOCKED');
  });

  for (const gate of ['legal', 'accounting', 'warehouse', 'courier']) {
    it.each([
      undefined,
      null,
      true,
      'VERIFIED',
      {},
      { status: 'UNKNOWN' },
      { status: 'STALE', evidenceRef: 'review' },
      { status: 'REJECTED', evidenceRef: 'review' },
      { status: 'VERIFIED' },
      { status: 'VERIFIED', evidenceRef: '' },
      { status: 'VERIFIED', evidenceRef: 'review', override: true },
    ])(`fails closed for ${gate}: %s`, (value) => {
      const state = draft();
      const gates = { ...evidence(state), [gate]: value };
      expect(assessW3DeliveryPolicyGates(state, gates).blockers).toContain(
        `${gate.toUpperCase()}_UNVERIFIED`,
      );
      expect(() =>
        simulateW3DeliveryPolicyTransition(state, 'ACTIVE', 1, gates),
      ).toThrow('GATES_BLOCKED');
    });
  }

  it.each(['policyId', 'policyVersion', 'policyFingerprint'])(
    'rejects gate evidence bound to another %s',
    (field) => {
      const state = draft();
      const gates = {
        ...evidence(state),
        [field]: field === 'policyVersion' ? 2 : 'other',
      };
      expect(() =>
        simulateW3DeliveryPolicyTransition(state, 'ACTIVE', 1, gates),
      ).toThrow('GATES_BLOCKED');
    },
  );

  it('invalidates all gate evidence after a policy revision', () => {
    const first = draft();
    const second = reviseW3DeliveryPolicyDraft(first, parameters(), 1);
    expect(() =>
      simulateW3DeliveryPolicyTransition(second, 'ACTIVE', 2, evidence(first)),
    ).toThrow('GATES_BLOCKED');
  });

  it('even apparently verified inputs only permit simulated Active and keep cutover blocked', () => {
    const first = draft();
    const gates = evidence(first);
    expect(assessW3DeliveryPolicyGates(first, gates).blockers).toEqual([
      'FINANCIAL_CUTOVER_CLOSED',
    ]);
    const active = simulateW3DeliveryPolicyTransition(
      first,
      'ACTIVE',
      1,
      gates,
    );
    expect(active).toMatchObject({
      mode: 'NON_EXECUTABLE_PREVIEW',
      financialExecution: 'BLOCKED',
      status: 'ACTIVE',
    });
    expect(first.status).toBe('DRAFT');
  });

  it('rejects tampered snapshots instead of silently accepting changed parameters', () => {
    const state = structuredClone(draft());
    (state.policy.parameters as ReturnType<typeof parameters>).feeCeilingVnd =
      1;
    expect(() => assessW3DeliveryPolicyGates(state)).toThrow(
      'SNAPSHOT_MISMATCH',
    );
    expect(() => reviseW3DeliveryPolicyDraft(state, parameters(), 1)).toThrow(
      'SNAPSHOT_MISMATCH',
    );
  });

  it('checks revision and policy-version increment overflow', () => {
    const state = { ...draft(), revision: Number.MAX_SAFE_INTEGER };
    expect(() =>
      reviseW3DeliveryPolicyDraft(state, parameters(), state.revision),
    ).toThrow('INTEGER_OVERFLOW');
    expect(() =>
      simulateW3DeliveryPolicyTransition(state, 'RETIRED', state.revision),
    ).toThrow('INTEGER_OVERFLOW');
  });
});

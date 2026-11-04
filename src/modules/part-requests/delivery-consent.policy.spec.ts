import { describe, expect, it } from 'vitest';
import { Role } from '../../shared/enums';
import { assertShippingFinancialCutoverAllowed } from '../finance/invoice-shipping-snapshot';
import {
  applyDeliveryCommand,
  createDeliveryProposal,
} from './delivery-consent.policy';

const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  partRequestId: 'request-1',
  serviceOrderId: 'order-1',
  customerId: 'customer-1',
  technicianId: 'technician-1',
  responsibleServiceManagerId: 'manager-1',
};
const manager = {
  id: scope.responsibleServiceManagerId,
  role: Role.SERVICE_MANAGER,
};
const customer = { id: scope.customerId, role: Role.CUSTOMER };
const technician = { id: scope.technicianId, role: Role.TECHNICIAN };
const budget = {
  laborTotal: 100_000,
  commissionAmount: 10_000,
  knownApprovedDeductions: 0,
};
const proposal = (overrides = {}) => ({
  kind: 'PROPOSE' as const,
  commandId: key(1),
  expectedVersion: 0,
  totalShippingFee: 20_000,
  budget: { ...budget },
  evidenceRef: 'courier-quote-1',
  approvedCostRef: 'approved-cost-1',
  ...overrides,
});
const make = (overrides = {}) =>
  createDeliveryProposal(scope, proposal(overrides), manager);
const consent = (
  s: ReturnType<typeof make>,
  who = customer,
  commandId = key(2),
  overrides = {},
) => ({
  kind: 'CONSENT' as const,
  commandId,
  expectedVersion: s.version,
  quoteVersion: s.quote.quoteVersion,
  quoteFingerprint: s.quote.fingerprint,
  totalShippingFee: s.quote.totalShippingFee,
  shippingShare:
    who.role === Role.CUSTOMER
      ? s.quote.customerShippingShare
      : s.quote.technicianShippingShare,
  accepted: true as const,
  evidenceRef: `consent-evidence-${commandId}`,
  ...overrides,
});
const approve = (s = make()) => {
  s = applyDeliveryCommand(s, consent(s), customer);
  return applyDeliveryCommand(s, consent(s, technician, key(3)), technician);
};
const actual = (
  s: ReturnType<typeof make>,
  totalShippingFee = 20_000,
  overrides = {},
) => ({
  kind: 'RECORD_ACTUAL' as const,
  commandId: key(4),
  expectedVersion: s.version,
  quoteVersion: s.quote.quoteVersion,
  totalShippingFee,
  evidenceRef: 'courier-actual-1',
  ...overrides,
});
const revise = (s: ReturnType<typeof make>, overrides = {}) => ({
  ...proposal(),
  kind: 'REVISE' as const,
  commandId: key(5),
  expectedVersion: s.version,
  totalShippingFee: 25_000,
  evidenceRef: 'courier-quote-2',
  approvedCostRef: 'approved-cost-2',
  ...overrides,
});

describe('W3 Phase A pure versioned dual consent (no persistence or dispatch authority)', () => {
  it('derives a deterministic 14000/6000 quote and immutable proposal receipt', () => {
    const s = make();
    expect(s).toMatchObject({
      version: 1,
      status: 'AWAITING_DUAL_CONSENT',
      customerConsent: null,
      technicianConsent: null,
      actual: null,
      payoutBlockReason: 'FINANCIAL_CUTOVER_CLOSED',
      quote: {
        quoteVersion: 1,
        policyVersion: 'W3_70_30_V1',
        totalShippingFee: 20_000,
        customerShippingShare: 14_000,
        technicianShippingShare: 6_000,
        netLaborAfterShipping: 84_000,
      },
    });
    expect(s).toEqual(make());
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0]).toMatchObject({
      commandId: key(1),
      actor: manager,
      resultVersion: 1,
    });
    expect(s.quote.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([customer, technician])(
    'requires explicit same-version consent in either actor order: %j',
    (first) => {
      const second = first.role === Role.CUSTOMER ? technician : customer;
      let s = make();
      s = applyDeliveryCommand(s, consent(s, first), first);
      expect(s.status).toBe('AWAITING_DUAL_CONSENT');
      s = applyDeliveryCommand(s, consent(s, second, key(3)), second);
      expect(s.status).toBe('CONSENTED');
      expect(s.version).toBe(3);
      for (const receipt of [s.customerConsent!, s.technicianConsent!]) {
        expect(receipt).toMatchObject({
          quoteVersion: 1,
          totalShippingFee: 20_000,
          quoteFingerprint: s.quote.fingerprint,
        });
        expect(receipt.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      }
    },
  );

  it('replays the same committed command before stale-version checks without rewinding newer state', () => {
    const initial = make();
    const c = consent(initial);
    const approved = applyDeliveryCommand(
      applyDeliveryCommand(initial, c, customer),
      consent({ ...initial, version: 2 }, technician, key(3)),
      technician,
    );
    expect(applyDeliveryCommand(approved, c, customer)).toBe(approved);
    expect(applyDeliveryCommand(approved, proposal(), manager)).toBe(approved);
    expect(approved.receipts).toHaveLength(3);
  });

  it.each([
    { shippingShare: 13999 },
    { totalShippingFee: 20001 },
    { quoteVersion: 2 },
    { quoteFingerprint: '0'.repeat(64) },
    { accepted: false },
    { evidenceRef: '' },
  ])(
    'rejects mismatched/implicit consent %j without changing input',
    (overrides) => {
      const s = make();
      const before = JSON.stringify(s);
      expect(() =>
        applyDeliveryCommand(
          s,
          consent(s, customer, key(2), overrides) as never,
          customer,
        ),
      ).toThrow();
      expect(JSON.stringify(s)).toBe(before);
    },
  );

  it('conflicts on a reused key with different payload or actor', () => {
    const initial = make();
    const c = consent(initial);
    const s = applyDeliveryCommand(initial, c, customer);
    expect(() =>
      applyDeliveryCommand(
        s,
        { ...c, evidenceRef: 'different-evidence' },
        customer,
      ),
    ).toThrow('COMMAND_CONFLICT');
    expect(() => applyDeliveryCommand(s, c, technician)).toThrow(
      'COMMAND_CONFLICT',
    );
    expect(() =>
      applyDeliveryCommand(s, { ...c, expectedVersion: s.version }, customer),
    ).toThrow('COMMAND_CONFLICT');
  });

  it('rejects a second consent command from the same actor even with the same money', () => {
    const s = applyDeliveryCommand(make(), consent(make()), customer);
    expect(() =>
      applyDeliveryCommand(s, consent(s, customer, key(9)), customer),
    ).toThrow('CONSENT_ALREADY_RECORDED');
    expect(() =>
      applyDeliveryCommand(
        s,
        consent(s, customer, key(9), { shippingShare: 14001 }),
        customer,
      ),
    ).toThrow();
  });

  it('serializes racing consent attempts by expectedVersion and allows retry against the committed revision', () => {
    const initial = make();
    const t = consent(initial, technician, key(3));
    const s = applyDeliveryCommand(initial, consent(initial), customer);
    expect(() => applyDeliveryCommand(s, t, technician)).toThrow(
      'STALE_VERSION',
    );
    expect(
      applyDeliveryCommand(s, { ...t, expectedVersion: s.version }, technician)
        .status,
    ).toBe('CONSENTED');
  });

  it('does not merge competing immutable branches or pretend to provide database atomicity', () => {
    const initial = make();
    const a = applyDeliveryCommand(initial, consent(initial), customer);
    const b = applyDeliveryCommand(
      initial,
      consent(initial, technician, key(3)),
      technician,
    );
    expect(a.version).toBe(2);
    expect(b.version).toBe(2); // Only a future DB CAS/unique receipt constraint can choose a winner.
    expect(a.status).toBe('AWAITING_DUAL_CONSENT');
    expect(b.status).toBe('AWAITING_DUAL_CONSENT');
    const merged = { ...a, technicianConsent: b.technicianConsent };
    expect(() => applyDeliveryCommand(merged, actual(merged), manager)).toThrow(
      'INVALID_STATE',
    );
  });

  it.each([
    { id: 'other-customer', role: Role.CUSTOMER },
    { id: scope.customerId, role: Role.TECHNICIAN },
    { id: scope.technicianId, role: Role.CUSTOMER },
    manager,
    { id: 'admin', role: Role.ADMIN },
  ])('rejects invalid consent actor %j', (actor) => {
    const s = make();
    expect(() => applyDeliveryCommand(s, consent(s), actor as never)).toThrow(
      'ACTOR_DENIED',
    );
  });

  it('restricts proposal, revision and actual to the bound service manager', () => {
    expect(() => createDeliveryProposal(scope, proposal(), customer)).toThrow(
      'ACTOR_DENIED',
    );
    const s = approve();
    for (const cmd of [revise(s), actual(s)]) {
      expect(() =>
        applyDeliveryCommand(s, cmd, { ...manager, id: 'other-manager' }),
      ).toThrow('ACTOR_DENIED');
      expect(() => applyDeliveryCommand(s, cmd, customer)).toThrow(
        'ACTOR_DENIED',
      );
    }
  });

  it('rejects conflated owner identities', () => {
    expect(() =>
      createDeliveryProposal(
        { ...scope, technicianId: scope.customerId },
        proposal(),
        manager,
      ),
    ).toThrow();
  });

  it('requires a fresh version and both renewed consents when actual exceeds the approved ceiling', () => {
    const old = approve();
    expect(() =>
      applyDeliveryCommand(old, actual(old, 25_000), manager),
    ).toThrow('RENEWED_DUAL_CONSENT_REQUIRED');
    let s = applyDeliveryCommand(old, revise(old), manager);
    expect(s).toMatchObject({
      version: 4,
      status: 'AWAITING_DUAL_CONSENT',
      quote: {
        quoteVersion: 2,
        customerShippingShare: 17_500,
        technicianShippingShare: 7_500,
      },
      customerConsent: null,
      technicianConsent: null,
      actual: null,
    });
    expect(() =>
      applyDeliveryCommand(
        s,
        consent(s, customer, key(6), { quoteVersion: 1 }),
        customer,
      ),
    ).toThrow('QUOTE_MISMATCH');
    expect(() =>
      applyDeliveryCommand(
        s,
        actual(s, 25_000, { commandId: key(8) }),
        manager,
      ),
    ).toThrow('DUAL_CONSENT_REQUIRED');
    s = applyDeliveryCommand(s, consent(s, customer, key(6)), customer);
    expect(() =>
      applyDeliveryCommand(
        s,
        actual(s, 25_000, { commandId: key(8) }),
        manager,
      ),
    ).toThrow('DUAL_CONSENT_REQUIRED');
    s = applyDeliveryCommand(s, consent(s, technician, key(7)), technician);
    s = applyDeliveryCommand(
      s,
      actual(s, 25_000, { commandId: key(8) }),
      manager,
    );
    expect(s.status).toBe('ACTUAL_RECORDED');
    expect(old.quote.totalShippingFee).toBe(20_000);
  });

  it.each([0, 1, 5, 19_999, 20_000])(
    'freezes actual %s under the ceiling without changing approved quote or invoice',
    (total) => {
      const approved = approve();
      const cmd = actual(approved, total);
      const s = applyDeliveryCommand(approved, cmd, manager);
      expect(s.status).toBe('ACTUAL_RECORDED');
      expect(s.actual).toMatchObject({
        totalShippingFee: total,
        approvedCeilingTotal: 20_000,
        quoteVersion: 1,
        evidenceRef: 'courier-actual-1',
        actor: manager,
      });
      expect(
        s.actual!.customerShippingShare + s.actual!.technicianShippingShare,
      ).toBe(total);
      expect(s.quote).toBe(approved.quote);
      expect(s.customerConsent).toBe(approved.customerConsent);
      expect(applyDeliveryCommand(s, cmd, manager)).toBe(s);
      expect(() =>
        applyDeliveryCommand(
          s,
          actual(s, total, { commandId: key(10) }),
          manager,
        ),
      ).toThrow('ACTUAL_ALREADY_RECORDED');
    },
  );

  it('requires both consents and actual evidence, including zero fee', () => {
    const s = make({ totalShippingFee: 0 });
    expect(() => applyDeliveryCommand(s, actual(s, 0), manager)).toThrow(
      'DUAL_CONSENT_REQUIRED',
    );
    const a = approve(s);
    expect(() =>
      applyDeliveryCommand(a, actual(a, 0, { evidenceRef: '' }), manager),
    ).toThrow();
  });

  it.each([
    { totalShippingFee: 19_000 },
    { evidenceRef: 'corrected-evidence' },
    { approvedCostRef: 'approved-cost-replacement' },
    { budget: { ...budget, commissionAmount: 11_000 } },
  ])(
    'clears consent and actual after any explicit proposal edit %j',
    (overrides) => {
      const initial = approve();
      const recorded = applyDeliveryCommand(initial, actual(initial), manager);
      const s = applyDeliveryCommand(
        recorded,
        revise(recorded, { totalShippingFee: 20_000, ...overrides }),
        manager,
      );
      expect(s).toMatchObject({
        quote: { quoteVersion: 2 },
        customerConsent: null,
        technicianConsent: null,
        actual: null,
        status: 'AWAITING_DUAL_CONSENT',
      });
      // Old receipt replay must not resurrect consent for quote v2.
      const oldReceipt = initial.receipts.find((r) => r.commandId === key(2))!;
      expect(
        applyDeliveryCommand(s, oldReceipt.command, oldReceipt.actor),
      ).toBe(s);
      expect(s.customerConsent).toBeNull();
    },
  );

  it('rejects stale revisions and stale actual commands rather than overwriting a newer quote', () => {
    const s = approve();
    const newer = applyDeliveryCommand(s, revise(s), manager);
    expect(() => applyDeliveryCommand(newer, actual(s), manager)).toThrow(
      'STALE_VERSION',
    );
    expect(() =>
      applyDeliveryCommand(newer, revise(s, { commandId: key(9) }), manager),
    ).toThrow('STALE_VERSION');
  });

  it.each([
    [0, 0, 0, 0],
    [1, 1, 0, 0],
    [2, 1, 1, 1],
    [5, 4, 1, 1],
    [15, 11, 4, 4],
  ])(
    'handles fee %s (customer %s / technician %s) exactly at the labor boundary',
    (s, c, t, labor) => {
      const state = make({
        totalShippingFee: s,
        budget: {
          laborTotal: labor,
          commissionAmount: 0,
          knownApprovedDeductions: 0,
        },
      });
      expect(state.quote).toMatchObject({
        customerShippingShare: c,
        technicianShippingShare: t,
        netLaborAfterShipping: 0,
      });
    },
  );

  it('rejects technician share above labor after commission and known approved deductions', () => {
    expect(() => make({ budget: { ...budget, laborTotal: 15_999 } })).toThrow(
      'INSUFFICIENT_NET_LABOR',
    );
    const s = make({
      budget: {
        laborTotal: 17_000,
        commissionAmount: 10_000,
        knownApprovedDeductions: 1000,
      },
    });
    expect(s.quote.netLaborAfterShipping).toBe(0);
    expect(s.payoutBlockReason).toBe('KNOWN_DEDUCTIONS_LEDGER_REQUIRED');
    expect(approve(s).payoutBlockReason).toBe(
      'KNOWN_DEDUCTIONS_LEDGER_REQUIRED',
    );
    expect(() =>
      make({
        budget: {
          laborTotal: 16_999,
          commissionAmount: 10_000,
          knownApprovedDeductions: 1000,
        },
      }),
    ).toThrow('INSUFFICIENT_NET_LABOR');
  });

  it('rechecks affordability on revisions and preserves the old state on failure', () => {
    const s = approve(make({ budget: { ...budget, laborTotal: 16_000 } }));
    expect(() =>
      applyDeliveryCommand(s, revise(s, { budget: s.quote.budget }), manager),
    ).toThrow('INSUFFICIENT_NET_LABOR');
    expect(s.status).toBe('CONSENTED');
  });

  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '20000',
    null,
    undefined,
  ])('rejects invalid courier amount %s', (value) => {
    expect(() => make({ totalShippingFee: value })).toThrow();
    const s = approve();
    expect(() =>
      applyDeliveryCommand(
        s,
        actual(s, 0, { totalShippingFee: value }) as never,
        manager,
      ),
    ).toThrow();
  });

  it('rejects unsafe/fractional budget components and overdraws using checked integer arithmetic', () => {
    for (const field of Object.keys(budget))
      for (const value of [
        -1,
        0.1,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        undefined,
      ]) {
        expect(() => make({ budget: { ...budget, [field]: value } })).toThrow();
      }
    expect(() =>
      make({
        budget: {
          laborTotal: Number.MAX_SAFE_INTEGER,
          commissionAmount: Number.MAX_SAFE_INTEGER,
          knownApprovedDeductions: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toThrow('INSUFFICIENT_NET_LABOR');
    const s = make({
      totalShippingFee: Number.MAX_SAFE_INTEGER,
      budget: {
        laborTotal: Number.MAX_SAFE_INTEGER,
        commissionAmount: 0,
        knownApprovedDeductions: 0,
      },
    });
    expect(s.quote.customerShippingShare).toBe(6_305_039_478_318_694);
    expect(s.quote.netLaborAfterShipping).toBe(6_305_039_478_318_694);
  });

  it.each([
    { commandId: '' },
    { commandId: 'not-a-uuid' },
    { evidenceRef: '' },
    { approvedCostRef: '' },
    { expectedVersion: NaN },
    { expectedVersion: -1 },
    { expectedVersion: 0.1 },
    { expectedVersion: 1 },
    { unexpected: true },
  ])('rejects incomplete or ambiguous proposal command %j', (overrides) => {
    expect(() => make(overrides)).toThrow();
  });

  it('rejects tampered quote/consent evidence instead of treating a partial object as dual consent', () => {
    const s = approve();
    expect(() =>
      applyDeliveryCommand(
        { ...s, quote: { ...s.quote, customerShippingShare: 1 } },
        actual(s),
        manager,
      ),
    ).toThrow();
    expect(() =>
      applyDeliveryCommand(
        { ...s, customerConsent: { ...s.customerConsent!, evidenceRef: '' } },
        actual(s),
        manager,
      ),
    ).toThrow();
    expect(() =>
      applyDeliveryCommand(
        { ...s, customerConsent: { ...s.customerConsent!, quoteVersion: 2 } },
        actual(s),
        manager,
      ),
    ).toThrow();
  });

  it('copies inputs, freezes nested outputs and never freezes caller-owned objects', () => {
    const cmd = proposal();
    const identities = { ...scope };
    const s = createDeliveryProposal(identities, cmd, manager);
    cmd.budget.laborTotal = 0;
    identities.customerId = 'mutated';
    expect(s.quote.budget.laborTotal).toBe(100_000);
    expect(s.scope.customerId).toBe('customer-1');
    expect(Object.isFrozen(cmd.budget)).toBe(false);
    for (const obj of [
      s,
      s.scope,
      s.quote,
      s.quote.budget,
      s.receipts,
      s.receipts[0],
      s.receipts[0].command,
      s.receipts[0].actor,
    ]) {
      expect(Object.isFrozen(obj)).toBe(true);
    }
    const a = applyDeliveryCommand(approve(s), actual(approve(s)), manager);
    expect(Object.isFrozen(a.actual)).toBe(true);
    expect(Object.isFrozen(a.customerConsent)).toBe(true);
  });

  it('validates serialized values independent of key order and returns an immutable replay copy', () => {
    const s = approve();
    const value = JSON.parse(JSON.stringify(s));
    value.scope = Object.fromEntries(Object.entries(value.scope).reverse());
    value.quote = Object.fromEntries(Object.entries(value.quote).reverse());
    const replay = value.receipts[1];
    const result = applyDeliveryCommand(value, replay.command, replay.actor);
    expect(result).toEqual(s);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts[1].command)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('cannot claim dispatch, financial activation or a new legacy policy through a command', () => {
    const s = approve();
    expect(() =>
      applyDeliveryCommand(
        s,
        { ...actual(s), kind: 'DISPATCH' } as never,
        manager,
      ),
    ).toThrow();
    expect(() => make({ policyVersion: 'LEGACY_100_0' })).toThrow();
    expect(() =>
      assertShippingFinancialCutoverAllowed({
        shippingPolicyVersion: 'W3_70_30_V1',
        shippingFee: 20_000,
        customerShippingShare: 14_000,
        technicianShippingShare: 6_000,
      }),
    ).toThrow();
    expect(s.payoutBlockReason).toBe('FINANCIAL_CUTOVER_CLOSED');
    expect(s.status).toBe('CONSENTED');
  });
});

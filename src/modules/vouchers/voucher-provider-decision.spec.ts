import { describe, expect, it } from 'vitest';
import { classifyVoucherProviderOutcome } from './voucher-provider-decision';

const intent = {
  attemptId: 'attempt-1', customerDueVnd: 450_000,
  reservedAt: new Date('2026-10-26T15:00:00.000Z'),
  expiresAt: new Date('2026-10-26T15:15:00.000Z'),
  initiatedAt: new Date('2026-10-26T15:14:59.000Z'),
};
const observedAt = new Date('2026-10-26T15:30:00.000Z');
const paid = {
  terminal: 'PAID' as const, signatureVerified: true,
  attemptId: intent.attemptId, amountVnd: intent.customerDueVnd,
  providerPaidAt: new Date('2026-10-26T15:14:59.500Z'),
};

describe('provider outcome for a funded voucher', () => {
  it('retains a valid in-flight attempt past expiry without guessing failure', () => {
    expect(classifyVoucherProviderOutcome(intent, { terminal: 'PENDING' }, observedAt))
      .toBe('KEEP_PENDING');
  });

  it('accepts signed paid evidence inside the hold even when the callback arrives late', () => {
    expect(classifyVoucherProviderOutcome(intent, paid, observedAt)).toBe('SETTLE');
  });

  it('quarantines a late or unverifiable success rather than redeeming or charging a difference', () => {
    expect(classifyVoucherProviderOutcome(intent, { ...paid,
      providerPaidAt: new Date('2026-10-26T15:15:00.000Z') }, observedAt)).toBe('QUARANTINE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, signatureVerified: false }, observedAt)).toBe('QUARANTINE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, amountVnd: 500_000 }, observedAt)).toBe('QUARANTINE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, attemptId: 'other-attempt' }, observedAt)).toBe('QUARANTINE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, providerPaidAt: null }, observedAt)).toBe('QUARANTINE');
  });

  it('releases only on a signed matching terminal failure', () => {
    expect(classifyVoucherProviderOutcome(intent, { ...paid, terminal: 'FAILED', providerPaidAt: null }, observedAt)).toBe('RELEASE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, terminal: 'FAILED', signatureVerified: false }, observedAt))
      .toBe('QUARANTINE');
    expect(classifyVoucherProviderOutcome(intent, { ...paid, terminal: 'FAILED',
      providerPaidAt: paid.providerPaidAt }, observedAt)).toBe('QUARANTINE');
  });

  it('quarantines an attempt started at or after the 15-minute boundary', () => {
    expect(classifyVoucherProviderOutcome({ ...intent, initiatedAt: intent.expiresAt }, paid, observedAt))
      .toBe('QUARANTINE');
  });
});

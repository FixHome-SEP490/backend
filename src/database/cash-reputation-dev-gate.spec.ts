import { describe, expect, it } from 'vitest';
import { planCashReputationMigrations } from './cash-reputation-dev-gate';

const prior = [
  'VoucherCore1792994400000', 'VoucherFundingLedger1792994400001',
  'VoucherCampaignLifecycle1793116800000', 'InterruptionWorkflow1793203200000',
];
const cash = 'CashPaymentIntents1793293200000';
const reputation = 'TechnicianResponsibility1793293200001';

describe('cash/reputation DEV migration whitelist', () => {
  it('accepts exact two pending migrations, first-only continuation and verified repeat', () => {
    expect(planCashReputationMigrations(prior, [...prior, cash, reputation])).toEqual([cash, reputation]);
    expect(planCashReputationMigrations([...prior, cash], [...prior, cash, reputation])).toEqual([reputation]);
    expect(planCashReputationMigrations([...prior, cash, reputation], [...prior, cash, reputation])).toEqual([]);
  });

  it('fails closed on missing prerequisite, reversed order, unknown pending or invalid ledger prefix', () => {
    expect(() => planCashReputationMigrations(prior.slice(0, 3), [...prior, cash, reputation])).toThrow();
    expect(() => planCashReputationMigrations(prior, [...prior, reputation, cash])).toThrow();
    expect(() => planCashReputationMigrations(prior, [...prior, cash, reputation, 'Unknown1793293200002'])).toThrow();
    expect(() => planCashReputationMigrations([...prior, reputation], [...prior, cash, reputation])).toThrow();
  });
});

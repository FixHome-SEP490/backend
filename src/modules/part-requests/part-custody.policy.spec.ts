import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityManager } from 'typeorm';
import { assertCashCustodyAllowsWithdrawal, assertCustodyRuntimeConfiguration, custodyUsageForInvoice, hasCashCustodyRestriction, hasPartReturnRestriction } from './part-custody.policy';
import { technicianEligibility } from '../bookings/technician-eligibility';
import { Booking } from '../bookings/entities/booking.entity';

describe('P1 cash restriction gates', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['false', 'true', false, true, true],
    ['false', 'false', false, true, false],
    ['true', 'false', false, true, false],
    ['false', 'true', true, false, false],
    ['true', 'false', true, false, true],
    ['false', 'false', false, false, true],
  ])('validates persisted mode against flags P1=%s / tracking=%s', async (p1, tracking, p1_enrolled, tracking_enrolled, allowed) => {
    vi.stubEnv('P1_CUSTODY_ENABLED', p1 as string);
    vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', tracking as string);
    const db = { query: vi.fn().mockResolvedValueOnce([{ installed: true, tracking_installed: true }]).mockResolvedValueOnce([{ p1_enrolled, tracking_enrolled }]) };
    const result = assertCustodyRuntimeConfiguration(db as unknown as EntityManager);
    if (allowed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow('cannot');
  });
  it('requires migration before tracking and fails closed on an unknown eligibility verdict', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false'); vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    const db = { query: vi.fn().mockResolvedValueOnce([{ installed: true, tracking_installed: false }]),
      find: vi.fn().mockResolvedValue([]) };
    await expect(assertCustodyRuntimeConfiguration(db as unknown as EntityManager)).rejects.toThrow('migration');
    db.query.mockResolvedValueOnce([]);
    await expect(hasPartReturnRestriction(db as unknown as EntityManager, 'tech')).rejects.toMatchObject({ status: 503 });
    expect(await custodyUsageForInvoice(db as unknown as EntityManager, 'order')).toEqual(new Map());
    expect(db.find).toHaveBeenCalledOnce();
  });
  it('blocks new discovery and Accept for tracking returns without touching cash or withdrawal', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    const db = { query: vi.fn().mockResolvedValue([{ blocked: true }]), findOneBy: vi.fn().mockResolvedValue(null), findOne: vi.fn() };
    for (const options of [undefined, { allowPausedExistingInvitation: true }]) {
      expect(await technicianEligibility(db as unknown as EntityManager, 'tech', {} as Booking, undefined, options)).toMatchObject({ eligible: false, reason: expect.stringContaining('linh kiện') });
    }
    expect(db.query.mock.calls.every(([sql]) => !sql.includes('cash_settlements'))).toBe(true);
    const count = db.query.mock.calls.length;
    await technicianEligibility(db as unknown as EntityManager, 'tech', {} as Booking, undefined, { keepingExistingOrder: true });
    await assertCashCustodyAllowsWithdrawal(db as unknown as EntityManager, 'tech');
    expect(db.query).toHaveBeenCalledTimes(count);
    expect(db.findOne).not.toHaveBeenCalled();
  });
  it('refuses to mix the finance P1 flag with return tracking', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    const db = { query: vi.fn().mockResolvedValue([{ installed: true }]) };
    await expect(assertCustodyRuntimeConfiguration(db as unknown as EntityManager)).rejects.toThrow('cannot');
  });
  it('refuses to start with flag OFF after any persisted cohort to prevent fallback to legacy payout', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    const db = { query: vi.fn().mockResolvedValueOnce([{ installed: true }]).mockResolvedValueOnce([{ enrolled: true }]) };
    await expect(assertCustodyRuntimeConfiguration(db as unknown as EntityManager)).rejects.toThrow('P1_CUSTODY_ENABLED');
  });
  it('allows an unmigrated legacy database with flag OFF', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false');
    const db = { query: vi.fn().mockResolvedValue([{ installed: false }]) };
    await expect(assertCustodyRuntimeConfiguration(db as unknown as EntityManager)).resolves.toBeUndefined();
  });
  it('defaults OFF and touches no new storage', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', '');
    const db = { query: vi.fn(), findOne: vi.fn() };
    expect(await hasCashCustodyRestriction(db as unknown as EntityManager, 'tech')).toBe(false);
    await assertCashCustodyAllowsWithdrawal(db as unknown as EntityManager, 'tech');
    expect(db.query).not.toHaveBeenCalled(); expect(db.findOne).not.toHaveBeenCalled();
  });
  it('blocks a pending invitation despite its pause bypass and skips custody for keeping assigned work', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    const db = { query: vi.fn().mockResolvedValue([{ blocked: true }]), findOneBy: vi.fn().mockResolvedValue(null) } as unknown as EntityManager;
    expect(await technicianEligibility(db, 'tech', {} as Booking, undefined, { allowPausedExistingInvitation: true })).toMatchObject({ eligible: false, reason: expect.stringContaining('linh kiện') });
    await technicianEligibility(db, 'tech', {} as Booking, undefined, { keepingExistingOrder: true });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('requires a technician lock before the withdrawal decision and fails closed on an unknown verdict', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'true');
    const calls: string[] = [];
    const db = {
      findOne: vi.fn(async () => { calls.push('lock'); return { id: 'tech' }; }),
      query: vi.fn(async () => { calls.push('guard'); return [{ blocked: true }]; }),
    };
    await expect(assertCashCustodyAllowsWithdrawal(db as unknown as EntityManager, 'tech')).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual(['lock', 'guard']);
    db.query.mockResolvedValueOnce([]);
    await expect(hasCashCustodyRestriction(db as unknown as EntityManager, 'tech')).rejects.toMatchObject({ status: 503 });
  });
});

import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WarrantyClaimStatus, WarrantyCustomerPrompt, WarrantyStatus, WarrantyVisitStatus } from '../../shared/enums';
import { WarrantySweepService } from './warranty-sweep.service';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1', serviceOrderId: 'order-1', customerId: 'customer-1', technicianId: 'tech-1',
  status: WarrantyClaimStatus.SUBMITTED, customerResponse: null, awaitingPrompt: null, resolutionNotes: null,
  noShowFlaggedAt: null, declineReview: null, lastReminderAt: null, updatedAt: ago(72),
  ...overrides,
});

/** `found` is what the candidate query returns; `locked` is what the row looks like once locked (it may have changed). */
const make = (options: { found?: unknown[]; locked?: unknown; visits?: unknown[]; requests?: unknown[]; config?: Record<string, number> } = {}) => {
  const tx = {
    findOne: vi.fn(async () => ('locked' in options ? options.locked : claim())),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const claimRepo = { find: vi.fn(async () => options.found ?? [claim()]) };
  const visitRepo = { find: vi.fn(async () => options.visits ?? []) };
  const requestRepo = { find: vi.fn(async () => options.requests ?? []) };
  const dataSource = {
    getRepository: (entity: { name: string }) => (entity.name === 'WarrantyVisit' ? visitRepo : entity.name === 'PartRequest' ? requestRepo : claimRepo),
    transaction: vi.fn(async (cb: any) => cb(tx)),
    query: vi.fn().mockResolvedValue(undefined),
  };
  const config = { getInt: vi.fn(async (key: string, fallback: number) => options.config?.[key] ?? fallback) };
  const notifier = { toUser: vi.fn().mockResolvedValue(undefined), toManagers: vi.fn().mockResolvedValue(undefined) };
  const partRequests = { settleWarrantyRequest: vi.fn().mockResolvedValue(undefined) };
  const cost = { chargeUnreturned: vi.fn().mockResolvedValue(undefined) };
  const service = new WarrantySweepService(dataSource as any, config as any, notifier as any, partRequests as any, cost as any);
  return { service, tx, claimRepo, visitRepo, requestRepo, dataSource, config, notifier, partRequests, cost };
};

describe('technician who never answers', () => {
  it('takes the claim back, remembers who was silent and asks a manager to reassign and judge', async () => {
    const { service, tx, notifier } = make();

    await service.sweepUnresponded(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({
      technicianId: null, declinedByTechnicianId: 'tech-1', declineReasonCode: 'no_response', declineReview: 'pending', declinedAt: NOW,
    }));
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_REASSIGN_NEEDED', 'order-1');
  });

  it('uses the configured window', async () => {
    const { service, claimRepo } = make({ config: { 'warranty.tech_response_hours': 24 } });
    await service.sweepUnresponded(NOW);
    const cutoff = (claimRepo.find.mock.calls as any)[0][0].where.updatedAt.value as Date;
    expect(cutoff.getTime()).toBe(ago(24).getTime());
  });

  it('leaves a claim that was accepted, reassigned or touched while it waited for the lock', async () => {
    for (const locked of [
      claim({ status: WarrantyClaimStatus.ACCEPTED }),
      claim({ technicianId: null }),
      claim({ updatedAt: ago(1) }),
      null,
    ]) {
      const { service, tx, notifier } = make({ locked });
      await service.sweepUnresponded(NOW);
      expect(tx.update).not.toHaveBeenCalled();
      expect(notifier.toManagers).not.toHaveBeenCalled();
    }
  });
});

describe('claim waiting for a technician', () => {
  it('reminds the managers once', async () => {
    const { service, tx, notifier } = make({ found: [claim({ technicianId: null })], locked: claim({ technicianId: null }) });

    await service.sweepUnassigned(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', { lastReminderAt: NOW });
    expect(notifier.toManagers).toHaveBeenCalledTimes(1);
  });

  it('does not remind again, or for a claim somebody just took', async () => {
    for (const locked of [claim({ technicianId: null, lastReminderAt: ago(1) }), claim({ technicianId: 'tech-3' })]) {
      const { service, tx, notifier } = make({ locked });
      await service.sweepUnassigned(NOW);
      expect(tx.update).not.toHaveBeenCalled();
      expect(notifier.toManagers).not.toHaveBeenCalled();
    }
  });
});

describe('technician who accepted but never showed', () => {
  const visit = (overrides: Record<string, unknown> = {}) => ({
    id: 'visit-1', warrantyClaimId: 'claim-1', technicianId: 'tech-1', status: WarrantyVisitStatus.SCHEDULED,
    createdAt: ago(100), scheduledAt: null, ...overrides,
  });
  const accepted = () => claim({ status: WarrantyClaimStatus.ACCEPTED });

  it('flags the claim for a manager, who decides whether it costs reputation', async () => {
    const { service, tx, notifier } = make({ visits: [visit()], locked: accepted() });

    await service.sweepNoShow(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', {
      noShowFlaggedAt: NOW, declineReview: 'pending', declinedByTechnicianId: 'tech-1', declineReasonCode: 'no_show', declinedAt: NOW,
    });
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_NO_SHOW', 'order-1');
  });

  it('waits for the agreed visit time when it is later than the deadline', async () => {
    const { service, tx } = make({ visits: [visit({ scheduledAt: new Date(NOW.getTime() + 3_600_000) })], locked: accepted() });
    await service.sweepNoShow(NOW);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('skips a claim already flagged, already waiting for review, handed to someone else or no longer accepted', async () => {
    for (const locked of [
      claim({ status: WarrantyClaimStatus.ACCEPTED, noShowFlaggedAt: ago(1) }),
      claim({ status: WarrantyClaimStatus.ACCEPTED, declineReview: 'pending' }),
      claim({ status: WarrantyClaimStatus.ACCEPTED, technicianId: 'tech-7' }),
      claim({ status: WarrantyClaimStatus.INSPECTED }),
    ]) {
      const { service, tx } = make({ visits: [visit()], locked });
      await service.sweepNoShow(NOW);
      expect(tx.update).not.toHaveBeenCalled();
    }
  });
});

describe('customer who stays silent', () => {
  const waiting = (prompt: WarrantyCustomerPrompt) => claim({ status: WarrantyClaimStatus.AWAITING_CUSTOMER, awaitingPrompt: prompt });

  it('accepts the finished work when asked to confirm it, and settles the part request', async () => {
    const { service, tx, notifier, partRequests } = make({ found: [waiting(WarrantyCustomerPrompt.COMPLETION)], locked: waiting(WarrantyCustomerPrompt.COMPLETION) });

    await service.sweepCustomerSilent(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({
      status: WarrantyClaimStatus.RESOLVED, outcomeCode: 'fixed', awaitingPrompt: null, awaitingSince: null, resolvedAt: NOW,
    }));
    expect(partRequests.settleWarrantyRequest).toHaveBeenCalledWith(tx, 'claim-1');
    expect(notifier.toUser).toHaveBeenCalledWith('customer-1', expect.any(String), expect.any(String), 'WARRANTY_DECISION_MADE', 'order-1');
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_DECISION_MADE', 'order-1');
  });

  it('accepts a not-covered conclusion by closing the claim as rejected', async () => {
    const { service, tx } = make({ found: [waiting(WarrantyCustomerPrompt.CONCLUSION)], locked: waiting(WarrantyCustomerPrompt.CONCLUSION) });

    await service.sweepCustomerSilent(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({
      status: WarrantyClaimStatus.REJECTED, outcomeCode: 'rejected',
    }));
  });

  it('keeps the manager note and also finds claims from before awaiting_since existed', async () => {
    const { service, tx, claimRepo } = make({
      found: [waiting(WarrantyCustomerPrompt.CONCLUSION)],
      locked: { ...waiting(WarrantyCustomerPrompt.CONCLUSION), resolutionNotes: 'Linh kiện hao mòn tự nhiên.' },
    });

    await service.sweepCustomerSilent(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'claim-1', expect.objectContaining({ resolutionNotes: 'Linh kiện hao mòn tự nhiên.' }));
    const where = (claimRepo.find.mock.calls as any)[0][0].where;
    expect(where).toHaveLength(2);
  });

  it('does not close a claim the customer answered while it waited for the lock', async () => {
    const { service, tx, partRequests, notifier } = make({
      found: [waiting(WarrantyCustomerPrompt.COMPLETION)],
      locked: { ...waiting(WarrantyCustomerPrompt.COMPLETION), customerResponse: 'agreed' },
    });

    await service.sweepCustomerSilent(NOW);

    expect(tx.update).not.toHaveBeenCalled();
    expect(partRequests.settleWarrantyRequest).not.toHaveBeenCalled();
    expect(notifier.toUser).not.toHaveBeenCalled();
  });
});

describe('expired coverage and the whole sweep', () => {
  it('marks only coverage with no open claim as expired', async () => {
    const { service, dataSource } = make();

    await service.sweepExpiredCoverage(NOW);

    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('NOT EXISTS');
    expect(params).toEqual([WarrantyStatus.EXPIRED, WarrantyStatus.ACTIVE, NOW, expect.arrayContaining(['submitted', 'in_progress', 'disputed'])]);
  });

  it('keeps going when one step fails', async () => {
    const { service, claimRepo, dataSource } = make();
    claimRepo.find.mockRejectedValueOnce(new Error('boom'));

    await service.sweep(NOW);

    expect(dataSource.query).toHaveBeenCalled();
    expect(claimRepo.find.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('faulty part that must come back', () => {
  const part = (overrides: Record<string, unknown> = {}) => ({
    id: 'pr-1', technicianId: 'tech-1', serviceOrderId: 'order-1', faultyReturnedAt: null, faultyReturnChargedAt: null,
    faultyReturnRemindedAt: null, faultyReturnDueAt: new Date(NOW.getTime() + 12 * 3_600_000), ...overrides,
  });

  it('reminds the technician once when the deadline is near, without charging', async () => {
    const { service, tx, notifier, cost } = make({ requests: [part()], locked: part() });

    await service.sweepFaultyReturn(NOW);

    expect(tx.update).toHaveBeenCalledWith(expect.anything(), 'pr-1', { faultyReturnRemindedAt: NOW });
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_FAULTY_PART_DUE', 'order-1');
    expect(cost.chargeUnreturned).not.toHaveBeenCalled();
  });

  it('stays quiet while the deadline is far and after the reminder was sent', async () => {
    const far = make({ requests: [part({ faultyReturnDueAt: new Date(NOW.getTime() + 5 * 86_400_000) })], locked: part({ faultyReturnDueAt: new Date(NOW.getTime() + 5 * 86_400_000) }) });
    await far.service.sweepFaultyReturn(NOW);
    const reminded = make({ requests: [part()], locked: part({ faultyReturnRemindedAt: ago(1) }) });
    await reminded.service.sweepFaultyReturn(NOW);

    expect(far.notifier.toUser).not.toHaveBeenCalled();
    expect(reminded.notifier.toUser).not.toHaveBeenCalled();
  });

  it('charges the new part once the deadline passed and tells the technician and the managers', async () => {
    const overdue = part({ faultyReturnDueAt: ago(2) });
    const { service, notifier, cost } = make({ requests: [overdue], locked: overdue });

    await service.sweepFaultyReturn(NOW);

    expect(cost.chargeUnreturned).toHaveBeenCalledWith(expect.anything(), overdue);
    expect(notifier.toUser).toHaveBeenCalledWith('tech-1', expect.any(String), expect.any(String), 'WARRANTY_FAULTY_PART_OVERDUE', 'order-1');
    expect(notifier.toManagers).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'WARRANTY_FAULTY_PART_OVERDUE', 'order-1');
  });

  it('leaves a part that came back or was charged while it waited for the lock', async () => {
    for (const locked of [part({ faultyReturnDueAt: ago(2), faultyReturnedAt: ago(1) }), part({ faultyReturnDueAt: ago(2), faultyReturnChargedAt: ago(1) }), null]) {
      const { service, cost, notifier } = make({ requests: [part({ faultyReturnDueAt: ago(2) })], locked });
      await service.sweepFaultyReturn(NOW);
      expect(cost.chargeUnreturned).not.toHaveBeenCalled();
      expect(notifier.toUser).not.toHaveBeenCalled();
    }
  });
});

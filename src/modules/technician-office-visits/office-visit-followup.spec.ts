import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ROLES_KEY } from '../../common/decorators';
import { OnboardingStatus, Role } from '../../shared/enums';
import { OfficeVisitStatus } from './entities/office-visit.entity';
import {
  AdminOfficeVisitsController,
  AdminProfileReviewsController,
  AdminVisitOfficesController,
} from './office-visit.controllers';
import { OfficeVisitsService } from './office-visits.service';
import { ProfileReviewService } from './profile-review.service';

const NOW = new Date('2026-11-10T08:00:00Z');

function sweepHarness(visits: Record<string, unknown>[], sent: Record<string, unknown>[] = []) {
  const notices = { find: vi.fn().mockResolvedValue(sent), insert: vi.fn() };
  const visitRepo = {
    find: vi.fn().mockResolvedValue(visits),
    findOne: vi.fn(async ({ where }) => visits.find((v) => v.id === where.id) ?? null),
    update: vi.fn(),
    count: vi.fn().mockResolvedValue(1),
    manager: { getRepository: () => notices },
  };
  const audit = { log: vi.fn() };
  const notifications = { createNotification: vi.fn() };
  const config = { getInt: vi.fn(async (_k: string, d: number) => d), getString: vi.fn(async (_k: string, d: string) => d) };
  const service = new OfficeVisitsService({} as never, visitRepo as never, {} as never, config as never, audit as never, notifications as never);
  return { service, visitRepo, audit, notifications, notices };
}

describe('office visit sweep', () => {
  it('marks an overdue visit missed as the system and tells the technician', async () => {
    const h = sweepHarness([{ id: 'v1', technicianId: 't1', status: OfficeVisitStatus.SCHEDULED, office: { name: 'Q1' } }]);
    expect(await h.service.sweepMissed(NOW)).toBe(1);
    expect(h.visitRepo.update).toHaveBeenCalledWith('v1', expect.objectContaining({ status: OfficeVisitStatus.MISSED }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, actorRole: null, action: 'OFFICE_VISIT_MISSED' }));
    expect(h.notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 't1' }));
  });

  it('skips a visit a manager handled in the meantime', async () => {
    const h = sweepHarness([{ id: 'v1', technicianId: 't1', status: OfficeVisitStatus.SCHEDULED }]);
    h.visitRepo.findOne.mockResolvedValue({ id: 'v1', technicianId: 't1', status: OfficeVisitStatus.ATTENDED });
    expect(await h.service.sweepMissed(NOW)).toBe(0);
    expect(h.visitRepo.update).not.toHaveBeenCalled();
  });

  it('reminds only visits within 24 hours that have no reminder yet', async () => {
    const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
    const office = { name: 'Q1' };
    const h = sweepHarness(
      [
        { id: 'soon', technicianId: 't1', scheduledAt: at(5), office },
        { id: 'sent', technicianId: 't2', scheduledAt: at(6), office },
        { id: 'far', technicianId: 't3', scheduledAt: at(48), office },
      ],
      [{ referenceId: 'sent' }],
    );
    expect(await h.service.sweepReminders(NOW)).toBe(1);
    expect(h.notices.insert).toHaveBeenCalledWith([expect.objectContaining({ userId: 't1', referenceId: 'soon', type: 'OFFICE_VISIT_REMINDER' })]);
  });
});

describe('ProfileReviewService.reopen', () => {
  const build = (profile: Record<string, unknown> | null) => {
    const profiles = { findOne: vi.fn().mockResolvedValue(profile), update: vi.fn() };
    const visits = { update: vi.fn() };
    const audit = { log: vi.fn() };
    const notifications = { createNotification: vi.fn() };
    const service = new ProfileReviewService(profiles as never, visits as never, {} as never, {} as never, audit as never, notifications as never);
    return { service, profiles, visits, audit, notifications };
  };

  it('cancels the attended visit, clears the rejection and invites the technician to book again', async () => {
    const h = build({ id: 'p1', onboardingStatus: OnboardingStatus.REJECTED, profileReviewRejectionReason: 'Thiếu bằng' });
    await h.service.reopen('t1', 'admin-1');
    expect(h.visits.update).toHaveBeenCalledWith({ technicianId: 't1', status: OfficeVisitStatus.ATTENDED }, expect.objectContaining({ status: OfficeVisitStatus.CANCELLED }));
    expect(h.profiles.update).toHaveBeenCalledWith('p1', { onboardingStatus: OnboardingStatus.SUBMITTED, profileReviewRejectionReason: null });
    expect(h.notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFICE_VISIT_RESET' }));
  });

  it('refuses a profile that was not rejected at the profile review', async () => {
    const h = build({ id: 'p1', onboardingStatus: OnboardingStatus.SUBMITTED, profileReviewRejectionReason: null });
    await expect(h.service.reopen('t1', 'admin-1')).rejects.toThrow(ConflictException);
  });
});

describe('office visit roles', () => {
  const roles = (controller: object) => Reflect.getMetadata(ROLES_KEY, controller);
  it('lets service managers handle visits but not offices or the final profile review', () => {
    expect(roles(AdminOfficeVisitsController)).toEqual([Role.ADMIN, Role.SERVICE_MANAGER]);
    expect(roles(AdminVisitOfficesController)).toEqual([Role.ADMIN]);
    expect(roles(AdminProfileReviewsController)).toEqual([Role.ADMIN]);
  });
});

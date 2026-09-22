import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { BookingStatus, InvitationStatus } from '../../shared/enums';
import { activateNextInvitation } from './activate-next-invitation';
import type { Booking } from './entities/booking.entity';
import type { BookingInvitation } from './entities/booking-invitation.entity';
import { technicianEligibility } from './technician-eligibility';

vi.mock('./technician-eligibility', () => ({ technicianEligibility: vi.fn() }));
const eligible = vi.mocked(technicianEligibility);

function setup(count: number, excluded: string[] = []) {
  const booking = { id: 'booking-1', status: BookingStatus.MATCHING } as Booking;
  const invitations = Array.from({ length: count }, (_, i) => ({
    id: `invite-${i + 1}`,
    bookingId: booking.id,
    technicianId: `technician-${i + 1}`,
    status: InvitationStatus.STANDBY,
    priorityOrder: i + 1,
    expiresAt: null,
  })) as BookingInvitation[];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const bookingUpdates: Array<Record<string, unknown>> = [];
  const manager = {
    findOneBy: vi.fn(async (_entity: unknown, where: { status: InvitationStatus }) =>
      invitations.find(invite => invite.status === where.status) ?? null),
    find: vi.fn(async (_entity: unknown, options: { where: { status: InvitationStatus } }) =>
      invitations.filter(invite => invite.status === options.where.status)),
    update: vi.fn(async (entity: { name?: string }, id: string, patch: Record<string, unknown>) => {
      if (entity.name === 'Booking') { bookingUpdates.push(patch); return { affected: 1 }; }
      const invitation = invitations.find(i => i.id === id);
      if (!invitation) throw new Error(`Unknown mock invitation ${id}`);
      Object.assign(invitation, patch);
      updates.push({ id, patch });
      return { affected: 1 };
    }),
  };
  eligible.mockImplementation(async (_manager, technicianId) => ({
    eligible: !excluded.includes(technicianId),
    reason: excluded.includes(technicianId) ? 'Not eligible' : undefined,
  }));
  const onActivated = vi.fn(async (_manager: EntityManager, _booking: Booking, _technicianId: string) => undefined);
  return { booking, invitations, manager: manager as unknown as EntityManager, updates, bookingUpdates, onActivated };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('BE-MATCH two customer-ranked technicians, sequential activation (synthetic EntityManager)', () => {
  it.each([1, 2])('notifies ONLY the first of %i eligible technicians', async count => {
    const s = setup(count);
    const before = Date.now();
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    const after = Date.now();
    expect(s.invitations[0].status).toBe(InvitationStatus.PENDING);
    expect(s.invitations[0].expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(s.invitations[0].expiresAt!.getTime()).toBeLessThanOrEqual(after + 30 * 60_000);
    expect(s.invitations.slice(1).every(i => i.status === InvitationStatus.STANDBY && i.expiresAt === null)).toBe(true);
    expect(s.onActivated).toHaveBeenCalledTimes(1);
    expect(s.onActivated).toHaveBeenCalledWith(s.manager, s.booking, 'technician-1');
    expect(s.bookingUpdates).toHaveLength(0);
  });

  it('only invites the second technician when the first explicitly declines', async () => {
    const s = setup(2);
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    s.invitations[0].status = InvitationStatus.DECLINED;
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.invitations.map(i => i.status)).toEqual([InvitationStatus.DECLINED, InvitationStatus.PENDING]);
    expect(s.onActivated.mock.calls.map(call => call[2])).toEqual(['technician-1', 'technician-2']);
    expect(s.invitations[1].expiresAt).toBeInstanceOf(Date);
  });

  it('skips an ineligible first technician and invites the second only', async () => {
    const s = setup(2, ['technician-1']);
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.invitations.map(i => i.status)).toEqual([InvitationStatus.EXPIRED, InvitationStatus.PENDING]);
    expect(s.onActivated.mock.calls.map(call => call[2])).toEqual(['technician-2']);
  });

  it('does not notify the second technician or reset TTL while first is pending', async () => {
    const s = setup(2);
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    const firstExpiry = s.invitations[0].expiresAt?.getTime();
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.invitations[0].expiresAt?.getTime()).toBe(firstExpiry);
    expect(s.invitations[1].status).toBe(InvitationStatus.STANDBY);
    expect(s.invitations[1].expiresAt).toBeNull();
    expect(s.onActivated).toHaveBeenCalledTimes(1);
  });

  it('closes only after both selected technicians are exhausted', async () => {
    const s = setup(2);
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    s.invitations[0].status = InvitationStatus.EXPIRED;
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.bookingUpdates).toHaveLength(0);
    s.invitations[1].status = InvitationStatus.DECLINED;
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.bookingUpdates).toEqual([{ status: BookingStatus.CLOSED }]);
  });

  it('closes if both candidates are no longer eligible', async () => {
    const s = setup(2, ['technician-1', 'technician-2']);
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.invitations.every(i => i.status === InvitationStatus.EXPIRED)).toBe(true);
    expect(s.onActivated).not.toHaveBeenCalled();
    expect(s.bookingUpdates).toEqual([{ status: BookingStatus.CLOSED }]);
  });

  it('does not activate standby invitations for a cancelled Booking', async () => {
    const s = setup(2);
    s.booking.status = BookingStatus.CANCELLED;
    await activateNextInvitation(s.manager, s.booking, 30, s.onActivated);
    expect(s.invitations.every(i => i.status === InvitationStatus.STANDBY)).toBe(true);
    expect(s.onActivated).not.toHaveBeenCalled();
    expect(s.bookingUpdates).toHaveLength(0);
  });
});
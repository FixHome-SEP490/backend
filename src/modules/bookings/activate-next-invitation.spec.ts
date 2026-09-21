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

describe('BE-MATCH activate selected concurrent invitation round (synthetic EntityManager)', () => {
  it.each([1, 3, 5])('activates ALL %i eligible technicians as PENDING in the same round', async count => {
    const scenario = setup(count);
    const before = Date.now();
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    const after = Date.now();
    expect(scenario.invitations.filter(i => i.status === InvitationStatus.PENDING)).toHaveLength(count);
    expect(scenario.invitations.filter(i => i.status === InvitationStatus.STANDBY)).toHaveLength(0);
    expect(scenario.onActivated).toHaveBeenCalledTimes(count);
    for (const invitation of scenario.invitations) {
      expect(invitation.expiresAt).toBeInstanceOf(Date);
      const expiry = invitation.expiresAt!.getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 30 * 60000);
      expect(expiry).toBeLessThanOrEqual(after + 30 * 60000);
    }
    expect(scenario.bookingUpdates).toHaveLength(0);
  });

  it('expires only ineligible standby candidates and activates every remaining eligible candidate', async () => {
    const scenario = setup(5, ['technician-2', 'technician-4']);
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.invitations.map(i => i.status)).toEqual([
      InvitationStatus.PENDING, InvitationStatus.EXPIRED, InvitationStatus.PENDING,
      InvitationStatus.EXPIRED, InvitationStatus.PENDING,
    ]);
    expect(scenario.onActivated.mock.calls.map(call => call[2])).toEqual([
      'technician-1', 'technician-3', 'technician-5',
    ]);
    expect(scenario.bookingUpdates).toHaveLength(0);
  });

  it('does not re-activate or extend a still-active pending round', async () => {
    const scenario = setup(3);
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    const expiry = scenario.invitations.map(i => i.expiresAt?.getTime());
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.onActivated).toHaveBeenCalledTimes(3);
    expect(scenario.invitations.map(i => i.expiresAt?.getTime())).toEqual(expiry);
    expect(scenario.bookingUpdates).toHaveLength(0);
  });

  it('does not close Booking while any other PENDING invite is still active', async () => {
    const scenario = setup(3);
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    scenario.invitations[0].status = InvitationStatus.DECLINED;
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.invitations.filter(i => i.status === InvitationStatus.PENDING)).toHaveLength(2);
    expect(scenario.bookingUpdates).toHaveLength(0);
  });

  it('closes Booking only when no pending/standby candidates remain', async () => {
    const scenario = setup(3);
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    scenario.invitations.forEach(i => { i.status = InvitationStatus.EXPIRED; });
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.bookingUpdates).toEqual([{ status: BookingStatus.CLOSED }]);
  });

  it('closes Booking if all candidates are ineligible before activation', async () => {
    const scenario = setup(3, ['technician-1', 'technician-2', 'technician-3']);
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.invitations.every(i => i.status === InvitationStatus.EXPIRED)).toBe(true);
    expect(scenario.onActivated).not.toHaveBeenCalled();
    expect(scenario.bookingUpdates).toEqual([{ status: BookingStatus.CLOSED }]);
  });

  it('does not activate any invitation outside MATCHING state', async () => {
    const scenario = setup(3);
    scenario.booking.status = BookingStatus.CANCELLED;
    await activateNextInvitation(scenario.manager, scenario.booking, 30, scenario.onActivated);
    expect(scenario.invitations.every(i => i.status === InvitationStatus.STANDBY)).toBe(true);
    expect(scenario.onActivated).not.toHaveBeenCalled();
    expect(scenario.bookingUpdates).toHaveLength(0);
  });
});
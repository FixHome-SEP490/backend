import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus } from '../../shared/enums';
import { InvitationsService } from './invitations.service';
import { technicianEligibility } from './technician-eligibility';

vi.mock('./technician-eligibility', () => ({ technicianEligibility: vi.fn() }));

function scenario(states: Array<{ status: InvitationStatus; minutesLeft?: number }>) {
  const booking = { id: 'booking-1', status: BookingStatus.MATCHING };
  const invites = states.map((s, index) => ({
    id: `invitation-${index + 1}`, bookingId: booking.id, technicianId: `tech-${index + 1}`,
    status: s.status, priorityOrder: index + 1,
    expiresAt: s.minutesLeft === undefined ? null : new Date(Date.now() + s.minutesLeft * 60000),
    respondedAt: null as Date | null,
  }));
  const manager = {
    findOne: vi.fn(async () => booking),
    find: vi.fn(async (_entity: unknown, query: { where: { status: InvitationStatus } }) => invites.filter(i => i.status === query.where.status)),
    findOneBy: vi.fn(async (_entity: unknown, query: { status: InvitationStatus }) => invites.find(i => i.status === query.status) ?? null),
    update: vi.fn(async (entity: { name?: string }, id: string, patch: Record<string, unknown>) => {
      if (entity.name === 'Booking') { Object.assign(booking, patch); return; }
      const i = invites.find(inv => inv.id === id);
      if (!i) throw new Error('Mock invitation not found');
      Object.assign(i, patch);
    }),
  };
  const configService = { getInt: vi.fn(async () => 30) };
  const messagingService = { ensureConversation: vi.fn(async () => undefined) };
  const service = new InvitationsService(
    {} as never, {} as never, { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    configService as never, {} as never, messagingService as never,
  );
  vi.mocked(technicianEligibility).mockResolvedValue({ eligible: true });
  return { service, invites, booking, manager, configService, messagingService };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('BE-MATCH request-time refresh of ordered PENDING invitations and legacy rows', () => {
  it('expires priority #1 and activates ONLY priority #2 when #1 expires', async () => {
    const s = scenario([
      { status: InvitationStatus.PENDING, minutesLeft: -1 },
      { status: InvitationStatus.STANDBY },
    ]);
    await s.service.refreshMatching('booking-1');
    expect(s.invites.map(i => i.status)).toEqual([InvitationStatus.EXPIRED, InvitationStatus.PENDING]);
    expect(s.invites[1].expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(s.configService.getInt).toHaveBeenCalledTimes(1);
    expect(s.messagingService.ensureConversation).toHaveBeenCalledTimes(1);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
  });

  it('does not prematurely invite priority #2 while #1 is live', async () => {
    const s = scenario([
      { status: InvitationStatus.PENDING, minutesLeft: 10 },
      { status: InvitationStatus.STANDBY },
    ]);
    await s.service.refreshMatching('booking-1');
    expect(s.invites.map(i => i.status)).toEqual([InvitationStatus.PENDING, InvitationStatus.STANDBY]);
    expect(s.configService.getInt).not.toHaveBeenCalled();
    expect(s.messagingService.ensureConversation).not.toHaveBeenCalled();
  });

  it('expires a stale sibling even when the first pending invitation is still valid', async () => {
    const s = scenario([
      { status: InvitationStatus.PENDING, minutesLeft: 10 },
      { status: InvitationStatus.PENDING, minutesLeft: -1 },
      { status: InvitationStatus.PENDING, minutesLeft: 5 },
    ]);
    await s.service.refreshMatching('booking-1');
    expect(s.invites.map(i => i.status)).toEqual([
      InvitationStatus.PENDING, InvitationStatus.EXPIRED, InvitationStatus.PENDING,
    ]);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.configService.getInt).not.toHaveBeenCalled();
  });

  it('expires each overdue invitation and closes only after the last PENDING expires', async () => {
    const s = scenario([
      { status: InvitationStatus.PENDING, minutesLeft: -1 },
      { status: InvitationStatus.PENDING, minutesLeft: 5 },
      { status: InvitationStatus.PENDING, minutesLeft: -2 },
    ]);
    await s.service.refreshMatching('booking-1');
    expect(s.invites.map(i => i.status)).toEqual([
      InvitationStatus.EXPIRED, InvitationStatus.PENDING, InvitationStatus.EXPIRED,
    ]);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    s.invites[1].expiresAt = new Date(Date.now() - 1000);
    await s.service.refreshMatching('booking-1');
    expect(s.invites.every(i => i.status === InvitationStatus.EXPIRED)).toBe(true);
    expect(s.booking.status).toBe(BookingStatus.CLOSED);
  });

  it('does not mutate invitations of an already-cancelled Booking', async () => {
    const s = scenario([{ status: InvitationStatus.PENDING, minutesLeft: -1 }]);
    s.booking.status = BookingStatus.CANCELLED;
    await s.service.refreshMatching('booking-1');
    expect(s.invites[0].status).toBe(InvitationStatus.PENDING);
    expect(s.booking.status).toBe(BookingStatus.CANCELLED);
  });
});
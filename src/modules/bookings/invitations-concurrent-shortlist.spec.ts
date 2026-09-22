// Exercises the real createShortlist -> activateNextInvitation transaction with fake persistence only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus, Role } from '../../shared/enums';
import { InvitationsService } from './invitations.service';
import { technicianEligibility } from './technician-eligibility';
vi.mock('./technician-eligibility', () => ({ technicianEligibility: vi.fn() }));

function scenario(status: BookingStatus = BookingStatus.SUBMITTED) {
  const booking = { id: 'booking-1', customerId: 'customer-1', status };
  const invites: Array<{ id: string; groupId?: string; technicianId: string; status: InvitationStatus; priorityOrder: number; expiresAt: Date | null }> = [];
  let nextInvitationId = 0;
  const manager = {
    findOne: vi.fn(async (_entity: unknown, query: { where: { id: string; customerId: string } }) =>
      query.where.customerId === booking.customerId && query.where.id === booking.id ? booking : null),
    findOneBy: vi.fn(async (entity: { name?: string }, query: { status?: InvitationStatus }) =>
      entity.name === 'ServiceOrder' ? null : invites.find(i => i.status === query.status) ?? null),
    find: vi.fn(async (_entity: unknown, query: { where: { status?: InvitationStatus } }) =>
      query.where.status ? invites.filter(i => i.status === query.where.status) : [...invites]),
    create: vi.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data, id: `invitation-${++nextInvitationId}` })),
    save: vi.fn(async (value: typeof booking | typeof invites) => {
      if (Array.isArray(value)) invites.push(...value);
      return value;
    }),
    update: vi.fn(async (entity: { name?: string }, id: string, patch: Record<string, unknown>) => {
      if (entity.name === 'Booking') { Object.assign(booking, patch); return; }
      const invite = invites.find(i => i.id === id);
      if (!invite) throw new Error('Invitation not found');
      Object.assign(invite, patch);
    }),
  };
  const audit = { logWithManager: vi.fn(async () => undefined) };
  const messaging = { ensureConversation: vi.fn(async () => undefined) };
  const service = new InvitationsService(
    {} as never, {} as never,
    { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    { getInt: vi.fn(async () => 30) } as never, audit as never, messaging as never,
  );
  vi.mocked(technicianEligibility).mockResolvedValue({ eligible: true });
  return { service, booking, invites, audit, messaging, manager };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('BE-MATCH customer shortlist sends all selected invitations in one round', () => {
  it.each([1, 3, 5])('activates %i distinct selected technicians with identical expiry', async count => {
    const s = scenario();
    const selected = Array.from({ length: count }, (_, i) => `tech-${i + 1}`);
    const result = await s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.CUSTOMER });
    expect(result).toHaveLength(count);
    expect(result.every(i => i.status === InvitationStatus.PENDING)).toBe(true);
    expect(s.invites.map(i => i.technicianId)).toEqual(selected);
    expect(s.invites.map(i => i.priorityOrder)).toEqual(selected.map((_id, i) => i + 1));
    expect(new Set(s.invites.map(i => i.groupId)).size).toBe(1);
    expect(s.invites[0].groupId).toBeDefined();
    expect(new Set(s.invites.map(i => i.expiresAt?.getTime())).size).toBe(1);
    expect(s.invites.every(i => i.expiresAt instanceof Date)).toBe(true);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.messaging.ensureConversation).toHaveBeenCalledTimes(count);
    expect(s.audit.logWithManager).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate technician ID without creating an invitation', async () => {
    const s = scenario();
    await expect(s.service.createShortlist('booking-1', ['tech-1', 'tech-1'], { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(s.invites).toHaveLength(0);
    expect(s.booking.status).toBe(BookingStatus.SUBMITTED);
  });

  it('rejects unauthorized customer, cancelled booking, and missing technician eligibility', async () => {
    const s = scenario();
    await expect(s.service.createShortlist('booking-1', ['tech-1'], { id: 'someone-else', role: Role.CUSTOMER })).rejects.toThrow();
    await expect(s.service.createShortlist('booking-1', ['tech-1'], { id: 'customer-1', role: Role.TECHNICIAN })).rejects.toThrow();
    s.booking.status = BookingStatus.CANCELLED;
    await expect(s.service.createShortlist('booking-1', ['tech-1'], { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    s.booking.status = BookingStatus.SUBMITTED;
    vi.mocked(technicianEligibility).mockResolvedValueOnce({ eligible: false, reason: 'Skill not verified' });
    await expect(s.service.createShortlist('booking-1', ['tech-1'], { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(s.invites).toHaveLength(0);
  });
});

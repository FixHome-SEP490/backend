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

describe('BE-MATCH customer selects exactly two technicians in priority order', () => {
  it('creates two ordered rows but sends an invitation only to priority #1', async () => {
    const s = scenario();
    const selected = ['tech-2', 'tech-1']; // customer order is authoritative, not ranking.
    const result = await s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.CUSTOMER });
    expect(result).toHaveLength(2);
    expect(s.invites.map(i => i.technicianId)).toEqual(selected);
    expect(s.invites.map(i => i.priorityOrder)).toEqual([1, 2]);
    expect(s.invites.map(i => i.status)).toEqual([InvitationStatus.PENDING, InvitationStatus.STANDBY]);
    expect(s.invites[0].expiresAt).toBeInstanceOf(Date);
    expect(s.invites[1].expiresAt).toBeNull();
    expect(new Set(s.invites.map(i => i.groupId)).size).toBe(1);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.messaging.ensureConversation).toHaveBeenCalledTimes(1);
    expect(s.messaging.ensureConversation).toHaveBeenCalledWith(s.manager, s.booking, 'tech-2');
    expect(s.audit.logWithManager).toHaveBeenCalledTimes(1);
  });

  it.each([{ selected: [] }, { selected: ['tech-1'] }, { selected: ['tech-1', 'tech-2', 'tech-3'] }, { selected: ['tech-1', 'tech-1'] }])(
    'refuses other than two distinct chosen technician IDs ($selected)', async ({ selected }) => {
      const s = scenario();
      await expect(s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
      expect(s.invites).toHaveLength(0);
      expect(s.booking.status).toBe(BookingStatus.SUBMITTED);
    },
  );

  it('refuses unauthorized customer, cancelled booking and ineligible selected technician', async () => {
    const s = scenario();
    const selected = ['tech-1', 'tech-2'];
    await expect(s.service.createShortlist('booking-1', selected, { id: 'someone-else', role: Role.CUSTOMER })).rejects.toThrow();
    await expect(s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.TECHNICIAN })).rejects.toThrow();
    s.booking.status = BookingStatus.CANCELLED;
    await expect(s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    s.booking.status = BookingStatus.SUBMITTED;
    vi.mocked(technicianEligibility).mockResolvedValueOnce({ eligible: false, reason: 'Skill not verified' });
    await expect(s.service.createShortlist('booking-1', selected, { id: 'customer-1', role: Role.CUSTOMER })).rejects.toThrow();
    expect(s.invites).toHaveLength(0);
  });
});
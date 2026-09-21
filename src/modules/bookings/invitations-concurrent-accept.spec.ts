// Synthetic transaction-manager tests for the actual InvitationsService.respond method.
// This verifies serial state transitions, not real PostgreSQL concurrent locking.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { InvitationsService } from './invitations.service';
import { technicianEligibility } from './technician-eligibility';

vi.mock('./technician-eligibility', () => ({ technicianEligibility: vi.fn() }));

function scenario(count: number) {
  const booking = { id: 'booking-1', status: BookingStatus.MATCHING, preferredStartAt: new Date(Date.now() + 3600000) };
  const invitations = Array.from({ length: count }, (_, i) => ({
    id: `invitation-${i + 1}`, bookingId: booking.id, technicianId: `tech-${i + 1}`,
    priorityOrder: i + 1, status: InvitationStatus.PENDING,
    expiresAt: new Date(Date.now() + 30 * 60000), respondedAt: null as Date | null,
  }));
  let serviceOrder: { id: string; bookingId: string; code: string; status: ServiceOrderStatus } | null = null;
  const assignments: Array<{ serviceOrderId: string; technicianId: string; isActive: boolean }> = [];
  let orderCreated = 0;
  const manager = {
    findOne: vi.fn(async (entity: { name?: string }, query: { where?: { id: string } }) =>
      entity.name === 'Booking' ? booking : { id: query.where?.id }),
    findOneByOrFail: vi.fn(async (entity: { name?: string }, query: { id?: string; bookingId?: string; technicianId?: string }) => {
      if (entity.name === 'ServiceOrder') {
        if (!serviceOrder) throw new Error('ServiceOrder not found');
        return serviceOrder;
      }
      const invitation = invitations.find(i => i.id === query.id && i.technicianId === query.technicianId);
      if (!invitation) throw new Error('Invitation not found');
      return invitation;
    }),
    findOneBy: vi.fn(async (entity: { name?: string }, query: { bookingId?: string; status?: InvitationStatus; serviceOrderId?: string; technicianId?: string; isActive?: boolean }) => {
      if (entity.name === 'ServiceOrder') return serviceOrder;
      if (entity.name === 'TechnicianAssignment') return assignments.find(a => a.serviceOrderId === query.serviceOrderId && a.technicianId === query.technicianId && a.isActive === query.isActive) ?? null;
      return invitations.find(i => i.bookingId === query.bookingId && i.status === query.status) ?? null;
    }),
    count: vi.fn(async () => assignments.filter(a => a.isActive).length),
    update: vi.fn(async (entity: { name?: string }, id: string | object, patch: Record<string, unknown>) => {
      if (entity.name === 'Booking') { Object.assign(booking, patch); return; }
      if (entity.name === 'BookingInvitation' && typeof id === 'string') {
        const inv = invitations.find(i => i.id === id);
        if (!inv) throw new Error('Invitation not found');
        Object.assign(inv, patch);
      }
    }),
    create: vi.fn((entity: { name?: string }, attrs: object) =>
      entity.name === 'ServiceOrder' ? { id: 'service-order-1', ...attrs } : attrs),
    save: vi.fn(async (entityOrValue: Record<string, unknown>, maybeValue?: Record<string, unknown>) => {
      // TypeORM supports both save(value) and save(Entity, value).
      const entity = maybeValue ?? entityOrValue;
      if ('code' in entity && 'bookingId' in entity) {
        orderCreated++;
        serviceOrder = entity as { id: string; bookingId: string; code: string; status: ServiceOrderStatus };
      } else if ('serviceOrderId' in entity && 'technicianId' in entity) {
        assignments.push(entity as (typeof assignments)[number]);
      }
      return entity;
    }),
    insert: vi.fn(async () => undefined),
    createQueryBuilder: vi.fn(() => {
      const query: { patch?: Record<string, unknown>; where?: Record<string, unknown> } = {};
      const qb = {
        update: vi.fn(() => qb),
        set: vi.fn((patch: Record<string, unknown>) => { query.patch = patch; return qb; }),
        where: vi.fn((_sql: string, params: Record<string, unknown>) => { query.where = params; return qb; }),
        execute: vi.fn(async () => {
          const winner = query.where?.id;
          invitations.filter(i => i.id !== winner && [InvitationStatus.PENDING, InvitationStatus.STANDBY].includes(i.status))
            .forEach(i => Object.assign(i, query.patch));
          return { affected: invitations.length - 1 };
        }),
      };
      return qb;
    }),
    find: vi.fn(async (_entity: unknown, query: { where: { status: InvitationStatus } }) =>
      invitations.filter(i => i.status === query.where.status)),
  };
  const repo = { findOneBy: vi.fn(async (query: { id: string; technicianId: string }) =>
    invitations.find(i => i.id === query.id && i.technicianId === query.technicianId) ?? null) };
  const audit = { logWithManager: vi.fn(async () => undefined) };
  const messaging = {
    ensureConversation: vi.fn(async () => undefined),
    attachToServiceOrder: vi.fn(async () => undefined),
  };
  const service = new InvitationsService(
    repo as never, {} as never,
    { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) } as never,
    { getInt: vi.fn(async () => 30) } as never, audit as never, messaging as never,
  );
  vi.mocked(technicianEligibility).mockResolvedValue({ eligible: true });
  const actor = (n: number) => ({ id: `tech-${n}`, role: Role.TECHNICIAN });
  return { service, invitations, booking, assignments, audit, messaging, actor,
    get serviceOrder() { return serviceOrder; }, get orderCreated() { return orderCreated; } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('BE-MATCH first valid Accept is the only winner', () => {
  it.each([[1, 1], [3, 2], [5, 5]])('%i simultaneously pending invitations: technician %i wins; remaining cannot Accept', async (count, winner) => {
    const s = scenario(count);
    const result = await s.service.respond(`invitation-${winner}`, 'ACCEPT', s.actor(winner));
    expect(result.serviceOrder?.id).toBe('service-order-1');
    expect(s.booking.status).toBe(BookingStatus.MATCHED);
    expect(s.orderCreated).toBe(1);
    expect(s.assignments).toHaveLength(1);
    expect(s.assignments[0].technicianId).toBe(`tech-${winner}`);
    expect(s.invitations.filter(i => i.status === InvitationStatus.ACCEPTED)).toHaveLength(1);
    expect(s.invitations.filter(i => i.status === InvitationStatus.CANCELLED)).toHaveLength(count - 1);
    for (let n = 1; n <= count; n++) {
      if (n === winner) continue;
      await expect(s.service.respond(`invitation-${n}`, 'ACCEPT', s.actor(n))).rejects.toThrow();
    }
    expect(s.orderCreated).toBe(1);
    expect(s.assignments).toHaveLength(1);
    const retry = await s.service.respond(`invitation-${winner}`, 'ACCEPT', s.actor(winner));
    expect(retry.serviceOrder?.id).toBe('service-order-1');
    expect(s.orderCreated).toBe(1);
    expect(s.assignments).toHaveLength(1);
    expect(s.audit.logWithManager).toHaveBeenCalledTimes(1);
    expect(s.messaging.attachToServiceOrder).toHaveBeenCalledTimes(1);
  });

  it('declining one invitation leaves another eligible PENDING until its own response', async () => {
    const s = scenario(3);
    const declined = await s.service.respond('invitation-1', 'DECLINE', s.actor(1));
    expect(declined.invitation.status).toBe(InvitationStatus.DECLINED);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.invitations.slice(1).every(i => i.status === InvitationStatus.PENDING)).toBe(true);
    await s.service.respond('invitation-3', 'ACCEPT', s.actor(3));
    expect(s.invitations[0].status).toBe(InvitationStatus.DECLINED);
    expect(s.invitations[1].status).toBe(InvitationStatus.CANCELLED);
    expect(s.orderCreated).toBe(1);
  });

  it('an expired invitation cannot win even while another pending invitation remains valid', async () => {
    const s = scenario(3);
    s.invitations[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.service.respond('invitation-1', 'ACCEPT', s.actor(1))).rejects.toThrow();
    expect(s.invitations[0].status).toBe(InvitationStatus.EXPIRED);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.orderCreated).toBe(0);
    await s.service.respond('invitation-2', 'ACCEPT', s.actor(2));
    expect(s.orderCreated).toBe(1);
  });

  it('rejects replayed Accept after winner is unassigned and another technician owns the order', async () => {
    const s = scenario(2);
    const accepted = await s.service.respond('invitation-1', 'ACCEPT', s.actor(1));
    expect(accepted.serviceOrder?.id).toBe('service-order-1');
    expect(s.assignments).toHaveLength(1);
    s.assignments[0].isActive = false;
    s.assignments.push({ serviceOrderId: 'service-order-1', technicianId: 'tech-2', isActive: true });
    await expect(s.service.respond('invitation-1', 'ACCEPT', s.actor(1))).rejects.toThrow();
    expect(s.orderCreated).toBe(1);
    expect(s.assignments.filter(a => a.isActive).map(a => a.technicianId)).toEqual(['tech-2']);
  });
  it('rejects a non-technician and an invitation belonging to another technician', async () => {
    const s = scenario(3);
    await expect(s.service.respond('invitation-1', 'ACCEPT', { id: 'tech-1', role: Role.CUSTOMER })).rejects.toThrow();
    await expect(s.service.respond('invitation-1', 'ACCEPT', s.actor(2))).rejects.toThrow();
    expect(s.orderCreated).toBe(0);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
  });

  it('rejects newly ineligible technician at Accept, leaving other pending candidates', async () => {
    const s = scenario(3);
    vi.mocked(technicianEligibility).mockResolvedValueOnce({ eligible: false, reason: 'Skill not verified' });
    await expect(s.service.respond('invitation-1', 'ACCEPT', s.actor(1))).rejects.toThrow();
    expect(s.orderCreated).toBe(0);
    expect(s.booking.status).toBe(BookingStatus.MATCHING);
    expect(s.invitations[1].status).toBe(InvitationStatus.PENDING);
  });

  it('passes the pause exemption only after valid PENDING Accept validation', async () => {
    const s = scenario(2);
    await s.service.respond('invitation-1', 'DECLINE', s.actor(1));
    expect(technicianEligibility).not.toHaveBeenCalled();
    await s.service.respond('invitation-2', 'ACCEPT', s.actor(2));
    expect(technicianEligibility).toHaveBeenCalledWith(
      expect.anything(), 'tech-2', expect.anything(), undefined,
      { allowPausedExistingInvitation: true },
    );
  });
});

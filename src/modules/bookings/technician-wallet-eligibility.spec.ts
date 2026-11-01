import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { AccountStatus, BookingStatus, InvitationStatus, Role, VerificationStatus } from '../../shared/enums';
import { Booking } from './entities/booking.entity';
import { InvitationsService } from './invitations.service';
import { loadEligibilityBulk, technicianEligibility } from './technician-eligibility';

function fixture(initialBalance: number | null) {
  const user = { id: 'user-tech', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE };
  const profile = { id: 'profile-tech', userId: user.id, user, verificationStatus: VerificationStatus.VERIFIED,
    isAvailable: true, serviceRadiusKm: 10 };
  const booking = { id: 'booking', serviceId: 'service', customerId: 'customer', status: BookingStatus.MATCHING,
    latitudeSnapshot: 10.77, longitudeSnapshot: 106.7, bookingMode: 'scheduled', slot: 'morning',
    preferredStartAt: new Date('2030-10-15T01:00:00Z'), preferredEndAt: new Date('2030-10-15T05:00:00Z') } as Booking;
  let balance = initialBalance;
  const wallet = () => balance === null ? null : { technicianId: user.id, balance };
  const schedules = [{ technicianId: profile.id, dayOfWeek: 2, startTime: '08:00', endTime: '18:00' }];
  const address = { userId: user.id, lat: 10.77, lng: 106.7 };
  const skill = { technicianId: profile.id, serviceId: 'service' };
  const manager = {
    findOneBy: vi.fn(async (entity: { name: string }, where: Record<string, unknown>) => {
      switch (entity.name) {
        case 'User': return where.id === user.id ? user : null;
        case 'TechnicianProfile': return where.userId === user.id ? profile : null;
        case 'TechnicianSkill': return where.technicianId === profile.id ? skill : null;
        case 'Wallet': return where.technicianId === user.id ? wallet() : null;
        case 'Address': return where.userId === user.id ? address : null;
        default: return null;
      }
    }),
    findOne: vi.fn(async (entity: { name: string }, options: { where: Record<string, unknown> }) => {
      if (entity.name === 'Wallet') return options.where.technicianId === user.id ? wallet() : null;
      if (entity.name === 'Booking') return booking;
      if (entity.name === 'User') return user;
      return null;
    }),
    find: vi.fn(async (entity: { name: string }, options: { where: Record<string, any> }) => {
      switch (entity.name) {
        case 'TechnicianSkill': return [skill];
        case 'TechnicianSchedule': return schedules;
        case 'Address': return [address];
        case 'Wallet': return options.where.technicianId.value.includes(user.id) && wallet() ? [wallet()] : [];
        default: return [];
      }
    }),
    count: vi.fn(async () => 0),
    query: vi.fn(async () => []),
    createQueryBuilder: vi.fn(() => {
      const qb = { select: () => qb, addSelect: () => qb, innerJoin: () => qb,
        update: () => qb, set: () => qb, execute: async () => ({}),
        where: () => qb, andWhere: () => qb, getCount: async () => 0,
        getMany: async () => [], getRawMany: async () => [] };
      return qb;
    }),
    create: vi.fn((_entity: unknown, value: object) => ({ id: 'created', ...value })),
    save: vi.fn(async (entity: unknown, value?: unknown) => value ?? entity), insert: vi.fn(), update: vi.fn(),
  };
  const asManager = manager as unknown as EntityManager;
  return { manager, asManager, booking, user, profile, setBalance: (value: number | null) => { balance = value; },
    direct: (options?: Parameters<typeof technicianEligibility>[4]) => technicianEligibility(asManager, user.id, booking, undefined, options),
    bulk: () => loadEligibilityBulk(asManager, booking, [profile] as never) };
}

describe('#42 new-work wallet authority', () => {
  it.each([[null, false], [0, false], [199999, false], [200000, true], [200001, true]] as const)(
    'balance %s gives eligibility %s for the same User ID in single and loaded bulk paths', async (balance, eligible) => {
      const f = fixture(balance);
      const single = await f.direct();
      const bulk = await f.bulk();
      expect(await f.direct({ bulk })).toEqual(single);
      expect(single).toMatchObject({ eligible });
      if (!eligible) expect(single.reason).toMatch(/wallet/i);
      expect(bulk.wallets.has(f.profile.id)).toBe(false);
      if (balance !== null) expect(bulk.wallets.get(f.user.id)).toBe(balance);
    });

  it.each([null, 0, 199999])('preserves accepted-work rescheduling with balance %s', async balance => {
    const f = fixture(balance);
    f.profile.isAvailable = false;
    expect(await f.direct({ keepingExistingOrder: true })).toEqual({ eligible: true });
  });

  it.each([null, 0, 199999])('Accept rejects balance %s after an eligible shortlist, without creating work', async balance => {
    const f = fixture(200000);
    const bulk = await f.bulk();
    expect(await f.direct({ bulk })).toEqual({ eligible: true });
    const invitation = { id: 'invite', bookingId: f.booking.id, technicianId: f.user.id,
      status: InvitationStatus.PENDING, expiresAt: new Date(Date.now() + 60000) };
    Object.assign(f.manager, { queryRunner: { isTransactionActive: true }, findOneByOrFail: async () => invitation });
    const service = Object.assign(Object.create(InvitationsService.prototype), {
      invitationRepo: { findOneBy: async () => invitation },
      dataSource: { transaction: async (fn: (m: EntityManager) => unknown) => fn(f.asManager) },
      messagingService: { ensureConversation: async () => {}, attachToServiceOrder: async () => {} },
      auditLogService: { logWithManager: async () => {} },
    }) as InvitationsService;
    f.setBalance(balance);
    f.profile.isAvailable = false; // the pending-invitation pause exemption cannot bypass the wallet
    await expect(service.respond('invite', 'ACCEPT', { id: f.user.id, role: Role.TECHNICIAN }))
      .rejects.toMatchObject({ status: 409 });
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.manager.insert).not.toHaveBeenCalled();
    expect(invitation.status).toBe(InvitationStatus.PENDING);
    expect(f.booking.status).toBe(BookingStatus.MATCHING);
  });
});

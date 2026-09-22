import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus, Role } from '../../shared/enums';
import { InvitationsService } from './invitations.service';
import { Booking } from './entities/booking.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingInvitationGroup } from './entities/booking-invitation-group.entity';

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';

type InvitationRow = {
  id: string;
  bookingId: string;
  groupId: string | null;
  status: InvitationStatus;
  expiresAt: Date | null;
};

function scenario(options: {
  count?: number;
  booking?: Partial<Booking>;
  pendingExpiresAt?: Date | null;
  group?: Partial<BookingInvitationGroup> | null;
  groupId?: string | null;
  ttlMinutes?: number;
} = {}) {
  const now = Date.now();
  const booking = {
    id: BOOKING_ID,
    customerId: CUSTOMER_ID,
    status: BookingStatus.MATCHING,
    preferredEndAt: new Date(now + 60 * 60_000),
    ...options.booking,
  } as Booking;
  const group = options.group === null
    ? null
    : { id: GROUP_ID, bookingId: BOOKING_ID, extensionUsedAt: null, ...options.group } as BookingInvitationGroup;
  const groupId = options.groupId === undefined ? GROUP_ID : options.groupId;
  const pendingExpiresAt = options.pendingExpiresAt === undefined
    ? new Date(now + 10 * 60_000)
    : options.pendingExpiresAt;
  const invitations: InvitationRow[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    id: `invitation-${index + 1}`,
    bookingId: BOOKING_ID,
    groupId,
    status: InvitationStatus.PENDING,
    expiresAt: pendingExpiresAt,
  }));
  invitations.push({
    id: 'declined-1',
    bookingId: BOOKING_ID,
    groupId,
    status: InvitationStatus.DECLINED,
    expiresAt: null,
  });

  const calls: unknown[] = [];
  const queryBuilder = {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    execute: vi.fn(async () => {
      const set = queryBuilder.set.mock.calls.at(-1)?.[0] as { expiresAt?: Date } | undefined;
      for (const invitation of invitations) {
        if (invitation.status === InvitationStatus.PENDING) invitation.expiresAt = set?.expiresAt ?? invitation.expiresAt;
      }
      return { affected: invitations.filter(i => i.status === InvitationStatus.PENDING).length };
    }),
  };
  const manager = {
    findOne: vi.fn(async (entity: unknown, options: { where?: Record<string, unknown> }) => {
      calls.push(entity);
      if (entity === Booking) {
        return options.where?.customerId === CUSTOMER_ID ? booking : null;
      }
      if (entity === BookingInvitationGroup) {
        return group && options.where?.id === group.id && options.where?.bookingId === BOOKING_ID ? group : null;
      }
      return null;
    }),
    find: vi.fn(async (entity: unknown) => entity === BookingInvitation
      ? invitations.filter(i => i.status === InvitationStatus.PENDING)
      : []),
    update: vi.fn(async (entity: unknown, id: string, patch: Record<string, unknown>) => {
      if (entity === BookingInvitationGroup && group?.id === id) Object.assign(group, patch);
    }),
    createQueryBuilder: vi.fn(() => queryBuilder),
  };
  const dataSource = { transaction: vi.fn(async (callback: (tx: typeof manager) => unknown) => callback(manager)) };
  const configService = { getInt: vi.fn(async () => options.ttlMinutes ?? 30) };
  const service = new InvitationsService(
    {} as never,
    {} as never,
    dataSource as never,
    configService as never,
    { logWithManager: vi.fn(async () => undefined) } as never,
    { ensureConversation: vi.fn(async () => undefined) } as never,
  );
  return { service, booking, group, invitations, manager, queryBuilder, configService, calls, dataSource };
}

describe('customer matching group one-time TTL extension', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([1, 3, 5])('extends all %i live PENDING invitations to one shared expiry, preserving declined history', async count => {
    const s = scenario({ count });

    const result = await s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER });

    expect(result.extendedInvitationCount).toBe(count);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(new Set(s.invitations.filter(i => i.status === InvitationStatus.PENDING).map(i => i.expiresAt?.getTime())).size).toBe(1);
    expect(s.invitations.find(i => i.status === InvitationStatus.DECLINED)?.expiresAt).toBeNull();
    expect(s.group?.extensionUsedAt).toBeInstanceOf(Date);
    expect(Object.keys(result).sort()).toEqual(['bookingId', 'expiresAt', 'extendedInvitationCount', 'invitationGroupId'].sort());
    expect(JSON.stringify(result)).not.toContain('storage://');
  });

  it('requires the authenticated customer owner and never leaks a private booking response', async () => {
    const s = scenario({ booking: { addressTextSnapshot: 'private address' } });

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: 'stranger', role: Role.CUSTOMER })).rejects.toThrow();
    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: 'tech', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(s.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it.each([
    ['expired PENDING', { pendingExpiresAt: new Date(Date.now() - 1_000) }],
    ['no pending group', { count: 0 }],
    ['closed booking', { booking: { status: BookingStatus.CLOSED } }],
    ['matched booking', { booking: { status: BookingStatus.MATCHED } }],
    ['cancelled booking', { booking: { status: BookingStatus.CANCELLED } }],
    ['missing durable group', { group: null }],
    ['legacy ungrouped pending', { groupId: null }],
  ] as const)('refuses %s without changing any deadline', async (_label, options) => {
    const s = scenario(options);
    const before = s.invitations.map(i => i.expiresAt?.getTime() ?? null);

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER })).rejects.toThrow();

    expect(s.invitations.map(i => i.expiresAt?.getTime() ?? null)).toEqual(before);
    expect(s.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it.each([
    ['missing preferred arrival end', { preferredEndAt: null }],
    ['invalid preferred arrival end', { preferredEndAt: new Date(Number.NaN) }],
    ['past preferred arrival end', { preferredEndAt: new Date(Date.now() - 1_000) }],
  ] as const)('fails closed for %s without changing deadline or marker', async (_label, booking) => {
    const s = scenario({ booking });
    const before = s.invitations.map(i => i.expiresAt?.getTime() ?? null);

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER })).rejects.toThrow();

    expect(s.invitations.map(i => i.expiresAt?.getTime() ?? null)).toEqual(before);
    expect(s.group?.extensionUsedAt).toBeNull();
    expect(s.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('caps the extension at the preferred arrival window end', async () => {
    const windowEnd = new Date(Date.now() + 5 * 60_000);
    const s = scenario({ booking: { preferredEndAt: windowEnd }, pendingExpiresAt: new Date(Date.now() + 60_000) });

    const result = await s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER });

    expect(result.expiresAt.getTime()).toBe(windowEnd.getTime());
  });

  it('uses the trusted server TTL configuration instead of a client supplied duration', async () => {
    const startedAt = Date.now();
    const s = scenario({ ttlMinutes: 7, pendingExpiresAt: new Date(startedAt + 60_000) });

    const result = await s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER });

    expect(s.configService.getInt).toHaveBeenCalledWith('matching.invitation_ttl_minutes', 30);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 7 * 60_000 - 100);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(startedAt + 7 * 60_000 + 1_000);
  });

  it('fails closed when pending rows do not form one durable group', async () => {
    const s = scenario();
    s.invitations[1].groupId = '44444444-4444-4444-8444-444444444444';
    const before = s.invitations.map(i => i.expiresAt?.getTime() ?? null);

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER })).rejects.toThrow();

    expect(s.invitations.map(i => i.expiresAt?.getTime() ?? null)).toEqual(before);
    expect(s.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses to shorten an existing live deadline when the arrival window ends sooner', async () => {
    const windowEnd = new Date(Date.now() + 5 * 60_000);
    const s = scenario({ booking: { preferredEndAt: windowEnd }, pendingExpiresAt: new Date(Date.now() + 10 * 60_000) });
    const before = s.invitations.map(i => i.expiresAt?.getTime() ?? null);

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER })).rejects.toThrow();

    expect(s.invitations.map(i => i.expiresAt?.getTime() ?? null)).toEqual(before);
    expect(s.group?.extensionUsedAt).toBeNull();
  });

  it('durably refuses a retry after the marker is set and locks Booking before Group', async () => {
    const s = scenario();
    await s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER });
    const deadlines = s.invitations.map(i => i.expiresAt?.getTime() ?? null);

    await expect(s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER })).rejects.toThrow();

    expect(s.invitations.map(i => i.expiresAt?.getTime() ?? null)).toEqual(deadlines);
    expect(s.calls.slice(0, 2)).toEqual([Booking, BookingInvitationGroup]);
  });

  it('serializes concurrent retries through the transaction lock so only one consumes the marker', async () => {
    const s = scenario();
    let tail = Promise.resolve();
    s.dataSource.transaction.mockImplementation(async (callback: (tx: typeof s.manager) => unknown) => {
      const run = tail.then(() => callback(s.manager));
      tail = run.then(() => undefined, () => undefined);
      return run;
    });

    const outcomes = await Promise.allSettled([
      s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER }),
      s.service.extendPendingInvitationGroup(BOOKING_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(s.manager.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});

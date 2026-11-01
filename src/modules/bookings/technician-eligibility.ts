import { EntityManager, In } from 'typeorm';
import { ErrorCodes, type ErrorCode } from '../../shared/constants';
import { Booking } from './entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSchedule } from '../technicians/entities/technician-schedule.entity';
import { TechnicianTimeOff } from '../technicians/entities/technician-time-off.entity';
import { Address } from '../users/entities/address.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { AccountStatus, CommissionDueStatus, Role, VerificationStatus } from '../../shared/enums';
import { hasAvailableArrival, type ArrivalInterval } from './arrival-window';
import { bookingSession, sameSession, slotAt } from './booking-slots';
import { distanceToBooking, servesArea, technicianOrigin } from './technician-location';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { SystemConfig } from '../system-config/entities/system-config.entity';
import { hasPartReturnRestriction, partReturnsTrackingEnabled } from '../part-requests/part-custody.policy';
import { groupServiceIds } from './visit-group-guard';
import { InterruptionRebookSource } from './entities/interruption-rebook.entity';

type HeldOrderRow = { orderId: string; status: string; slot: string | null; mode: string | null; busyStart: Date | string | null; busyEnd: Date | string | null };

/**
 * Every order the technician holds that is not cancelled, optionally leaving one out.
 * The devices of one visit (PO 21/10/2026) share their session, so the orders of
 * the visit being asked about never clash with each other.
 */
async function heldOrders(manager: EntityManager, technicianId: string, excludeOrderId?: string, visitGroupId?: string | null): Promise<HeldOrderRow[]> {
  const held = manager.createQueryBuilder('technician_assignments', 'a')
    .select('o.id', 'orderId')
    .addSelect('o.status', 'status')
    .addSelect('b.slot', 'slot')
    .addSelect('b.booking_mode', 'mode')
    .addSelect('b.preferred_start_at', 'busyStart')
    .addSelect('b.preferred_end_at', 'busyEnd')
    .innerJoin('service_orders', 'o', 'o.id = a.service_order_id')
    .innerJoin('bookings', 'b', 'b.id = o.booking_id')
    .where('a.technician_id = :id AND a.is_active = true', { id: technicianId })
    .andWhere("o.status <> 'cancelled'");
  if (excludeOrderId) held.andWhere('o.id != :excludeOrderId', { excludeOrderId });
  if (visitGroupId) held.andWhere('(b.visit_group_id IS NULL OR b.visit_group_id != :visitGroupId)', { visitGroupId });
  return held.getRawMany<HeldOrderRow>();
}

/**
 * What the "free in this session?" check reads about one technician, read once
 * when many sessions are asked about together (the reschedule and rebook
 * calendars, PO 21/10/2026: 42 sessions one by one took about 15 s). Time off
 * is loaded for the whole range and filtered per session in memory.
 */
export interface EligibilityPreload {
  user: User | null;
  profile: TechnicianProfile | null;
  schedules: TechnicianSchedule[];
  timeOff: TechnicianTimeOff[];
  orders: HeldOrderRow[];
}

export async function loadEligibilityPreload(
  manager: EntityManager, technicianId: string, range: { start: Date; end: Date }, excludeOrderId?: string, visitGroupId?: string | null,
): Promise<EligibilityPreload> {
  const user = await manager.findOneBy(User, { id: technicianId });
  const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianId });
  const schedules = profile ? await manager.find(TechnicianSchedule, { where: { technicianId: profile.id } }) : [];
  const timeOff = profile
    ? await manager.createQueryBuilder(TechnicianTimeOff, 't')
      .where('t.technicianId = :id', { id: profile.id })
      .andWhere('t.startAt < :end AND t.endAt > :start', { start: range.start, end: range.end }).getMany()
    : [];
  const orders = await heldOrders(manager, technicianId, excludeOrderId, visitGroupId);
  return { user, profile, schedules, timeOff, orders };
}

/**
 * Everything technicianEligibility() reads about MANY technicians for one booking, read once with a handful of
 * queries instead of ~16 per technician. The candidate list asks about dozens of technicians, and each query is a
 * round trip to the database (the list took 20-30 s). Same checks, same order; only where the data comes from changes.
 */
export interface EligibilityBulk {
  withdrawn: Set<string>; declined: Set<string>; interrupted: Set<string>;
  /** null when part-return tracking is off: that mode keeps its own per-technician check. */
  partRestricted: Set<string> | null;
  serviceIds: string[]; skills: Set<string>;
  dues: Set<string>; wallets: Map<string, number>; minBalance: number;
  addresses: Map<string, Address>; areas: Map<string, TechnicianServiceArea[]>; gpsFreshMinutes: number;
  preloads: Map<string, EligibilityPreload>;
}

export async function loadEligibilityBulk(manager: EntityManager, booking: Booking, profiles: TechnicianProfile[]): Promise<EligibilityBulk> {
  const userIds = profiles.map((p) => p.userId);
  const profileIds = profiles.map((p) => p.id);
  const ids = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
  const start = booking.preferredStartAt ? new Date(booking.preferredStartAt) : null;
  const end = booking.preferredEndAt ? new Date(booking.preferredEndAt) : null;
  const windowOk = !!start && !!end && start < end;
  const arrivalStart = start ? new Date(Math.max(start.getTime(), Date.now())) : new Date();
  const serviceIds = await groupServiceIds(manager, booking);
  const [withdrawn, declined, interrupted, partRestricted, skills, dues, wallets, minConfig, gpsConfig, addresses, areas, schedules, timeOff, held] = await Promise.all([
    manager.query(`SELECT DISTINCT c.actor_user_id AS id FROM cancellations c JOIN service_orders o ON o.id = c.service_order_id WHERE o.booking_id = $1 AND c.actor = 'technician'`, [booking.id]),
    manager.query(`SELECT DISTINCT technician_id AS id FROM booking_invitations WHERE booking_id = $1 AND status = 'declined'`, [booking.id]),
    manager.find(InterruptionRebookSource, { where: { targetBookingId: booking.id } }),
    partReturnsTrackingEnabled()
      ? manager.query(`SELECT DISTINCT c.technician_id AS id FROM part_custodies c WHERE c.technician_id = ANY($1::uuid[]) AND c.tracking_only AND (c.state->>'outstandingQty')::int IS DISTINCT FROM 0`, [userIds])
      : Promise.resolve(null),
    manager.find(TechnicianSkill, { where: { technicianId: In(profileIds), serviceId: In(serviceIds), isActive: true, verificationStatus: VerificationStatus.VERIFIED } }),
    manager.find(CommissionDue, { where: { technicianId: In(userIds), status: CommissionDueStatus.PENDING } }),
    manager.find(Wallet, { where: { technicianId: In(userIds) } }),
    manager.findOneBy(SystemConfig, { key: 'wallet.minimum_balance' }),
    manager.findOneBy(SystemConfig, { key: 'matching.gps_fresh_minutes' }),
    manager.find(Address, { where: { userId: In(userIds), isDefault: true } }),
    manager.find(TechnicianServiceArea, { where: { technicianId: In(profileIds) } }),
    manager.find(TechnicianSchedule, { where: { technicianId: In(profileIds) } }),
    windowOk
      ? manager.createQueryBuilder(TechnicianTimeOff, 't').where('t.technicianId IN (:...profileIds)', { profileIds }).andWhere('t.startAt < :end AND t.endAt > :start', { start: arrivalStart, end }).getMany()
      : Promise.resolve([] as TechnicianTimeOff[]),
    heldOrdersFor(manager, userIds, undefined, booking.visitGroupId),
  ]);
  const by = <T>(rows: T[], key: (row: T) => string) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
    return map;
  };
  const schedulesBy = by(schedules, (s) => s.technicianId);
  const timeOffBy = by(timeOff, (t) => t.technicianId);
  const preloads = new Map<string, EligibilityPreload>();
  for (const p of profiles) {
    preloads.set(p.userId, { user: p.user ?? null, profile: p, schedules: schedulesBy.get(p.id) ?? [], timeOff: timeOffBy.get(p.id) ?? [], orders: held.get(p.userId) ?? [] });
  }
  return {
    withdrawn: ids(withdrawn), declined: ids(declined), interrupted: new Set(interrupted.map((r: InterruptionRebookSource) => r.previousTechnicianId)),
    partRestricted: partRestricted ? ids(partRestricted) : null,
    serviceIds, skills: new Set(skills.map((s) => `${s.technicianId}:${s.serviceId}`)),
    dues: new Set(dues.map((d) => d.technicianId)), wallets: new Map(wallets.map((w) => [w.technicianId, Number(w.balance)])),
    minBalance: minConfig ? Number(minConfig.value) : 200000,
    addresses: new Map(addresses.map((a) => [a.userId, a])), areas: by(areas, (a) => a.technicianId), gpsFreshMinutes: gpsConfig ? Number(gpsConfig.value) : 15,
    preloads,
  };
}

/** heldOrders() for many technicians in one query, keyed by technician. */
async function heldOrdersFor(manager: EntityManager, technicianIds: string[], excludeOrderId?: string, visitGroupId?: string | null): Promise<Map<string, HeldOrderRow[]>> {
  const held = manager.createQueryBuilder('technician_assignments', 'a')
    .select('a.technician_id', 'technicianId')
    .addSelect('o.id', 'orderId')
    .addSelect('o.status', 'status')
    .addSelect('b.slot', 'slot')
    .addSelect('b.booking_mode', 'mode')
    .addSelect('b.preferred_start_at', 'busyStart')
    .addSelect('b.preferred_end_at', 'busyEnd')
    .innerJoin('service_orders', 'o', 'o.id = a.service_order_id')
    .innerJoin('bookings', 'b', 'b.id = o.booking_id')
    .where('a.technician_id IN (:...technicianIds) AND a.is_active = true', { technicianIds })
    .andWhere("o.status <> 'cancelled'");
  if (excludeOrderId) held.andWhere('o.id != :excludeOrderId', { excludeOrderId });
  if (visitGroupId) held.andWhere('(b.visit_group_id IS NULL OR b.visit_group_id != :visitGroupId)', { visitGroupId });
  const map = new Map<string, HeldOrderRow[]>();
  for (const row of await held.getRawMany<HeldOrderRow & { technicianId: string }>()) map.set(row.technicianId, [...(map.get(row.technicianId) ?? []), row]);
  return map;
}

/** Same authority at discovery, shortlist, activation and Accept. IDs here are User IDs. */
export async function technicianEligibility(
  manager: EntityManager, technicianId: string, booking: Booking,
  excludeOrderId?: string,
  options?: {
    allowPausedExistingInvitation?: boolean;
    /**
     * The technician already holds this booking's order and the customer is
     * moving the window. Only "free at the new time" is asked: pausing new
     * jobs, the wallet minimum and an unpaid PlatformDue gate taking new work,
     * not keeping work already accepted; skill and distance did not change.
     */
    keepingExistingOrder?: boolean;
    /**
     * Data read once for many sessions of the same technician; only with
     * keepingExistingOrder, whose checks it covers. The same excludeOrderId
     * must have been used to load it.
     */
    preload?: EligibilityPreload;
    /** Data of many technicians read at once (candidate list); covers every lookup below, so no query is run per technician. */
    bulk?: EligibilityBulk;
  },
): Promise<{ eligible: boolean; reason?: string }> {
  const keeping = options?.keepingExistingOrder === true;
  const bulk = keeping ? undefined : options?.bulk;
  const fail = (reason: string) => ({ eligible: false, reason });
  // A technician who withdrew from this booking's order is not offered it again.
  if (!keeping && (bulk ? bulk.withdrawn.has(technicianId) : await manager.createQueryBuilder('cancellations', 'c')
    .innerJoin('service_orders', 'o', 'o.id = c.service_order_id')
    .where("o.booking_id = :bookingId AND c.actor = 'technician' AND c.actor_user_id = :technicianId", { bookingId: booking.id, technicianId })
    .getCount())) return fail('Technician withdrew from this booking');
  // Nor one who declined its invitation.
  if (!keeping && (bulk ? bulk.declined.has(technicianId) : await manager.count('booking_invitations', { where: { bookingId: booking.id, technicianId, status: 'declined' } }))) return fail('Technician declined this booking');
  if (!keeping && (bulk ? bulk.interrupted.has(technicianId) : await manager.count(InterruptionRebookSource, { where: { targetBookingId: booking.id, previousTechnicianId: technicianId } }))) {
    return fail('Previous technician is excluded from this interrupted booking');
  }
  if (!keeping && (bulk?.partRestricted ? bulk.partRestricted.has(technicianId) : await hasPartReturnRestriction(manager, technicianId))) return fail('Cần quản lý xác nhận đã nhận đủ linh kiện FixHome trước khi nhận việc mới.');
  const preload = keeping ? options?.preload : bulk?.preloads.get(technicianId);
  const user = preload ? preload.user : await manager.findOneBy(User, { id: technicianId });
  if (!user || user.role !== Role.TECHNICIAN || user.status !== AccountStatus.ACTIVE) return fail('Technician account is not active');
  const profile = preload ? preload.profile : await manager.findOneBy(TechnicianProfile, { userId: technicianId });
  if (!profile || profile.verificationStatus !== VerificationStatus.VERIFIED) return fail('Technician is not verified');
  if (profile.workSuspendedUntil && profile.workSuspendedUntil > new Date()) return fail('Technician is unavailable or suspended');
  if (!profile.isAvailable && !options?.allowPausedExistingInvitation && !keeping) return fail('Technician is unavailable or paused');
  // A visit of several devices needs one technician who offers every one of them.
  if (!keeping) {
    for (const serviceId of bulk ? bulk.serviceIds : await groupServiceIds(manager, booking)) {
      const offered = bulk ? bulk.skills.has(`${profile.id}:${serviceId}`)
        : !!await manager.findOneBy(TechnicianSkill, { technicianId: profile.id, serviceId, isActive: true, verificationStatus: VerificationStatus.VERIFIED });
      if (!offered) return fail('Service is not offered or not yet verified');
    }
  }
  if (!keeping && (bulk ? bulk.dues.has(technicianId) : await manager.count(CommissionDue, { where: { technicianId, status: CommissionDueStatus.PENDING } }))) return fail('Active unpaid PlatformDue');
  const balance = keeping ? null
    : bulk ? (bulk.wallets.get(technicianId) ?? null)
      // Accept and shortlist transactions retain this read lock until commit,
      // serializing the new-work decision with wallet debits/deletion.
      : await (manager.queryRunner?.isTransactionActive
        ? manager.findOne(Wallet, { where: { technicianId }, lock: { mode: 'pessimistic_read' } })
        : manager.findOneBy(Wallet, { technicianId })).then((w) => (w ? Number(w.balance) : null));
  if (!keeping) {
    const minConfig = bulk ? null : await manager.findOneBy(SystemConfig, { key: 'wallet.minimum_balance' });
    const minimumBalance = bulk ? bulk.minBalance : minConfig ? Number(minConfig.value) : 200000;
    if (balance === null || !Number.isFinite(balance) || balance < minimumBalance) {
      return fail('Minimum wallet balance is required to accept new jobs');
    }
  }
  if (!booking.preferredStartAt || !booking.preferredEndAt) return fail('Booking time window is missing');
  const start = new Date(booking.preferredStartAt);
  const end = new Date(booking.preferredEndAt);
  const now = Date.now();
  if (!(start < end) || end.getTime() <= now) return fail('Booking time window is invalid or expired');
  const arrivalStart = new Date(Math.max(start.getTime(), now));
  const window: ArrivalInterval = { start: arrivalStart, end };
  const mode = booking.bookingMode === 'urgent' ? 'urgent' : 'scheduled';
  const session = mode === 'scheduled' ? bookingSession(booking) : null;
  const schedules = preload ? preload.schedules : await manager.find(TechnicianSchedule, { where: { technicianId: profile.id } });
  const timeOff = preload
    ? preload.timeOff.filter((t) => new Date(t.startAt) < end && new Date(t.endAt) > arrivalStart)
    : await manager.createQueryBuilder(TechnicianTimeOff, 't')
      .where('t.technicianId = :id', { id: profile.id })
      .andWhere('t.startAt < :end AND t.endAt > :start', { start: arrivalStart, end }).getMany();
  if (timeOff.length) return fail('Technician has time off');
  if (!hasAvailableArrival(window, schedules, [])) return fail('Outside working schedule');

  // Every order the technician holds that is not cancelled, completed ones included:
  // a session counts as taken even after its order is done (one scheduled booking per session).
  const orders = (preload ? preload.orders : await heldOrders(manager, technicianId, excludeOrderId, booking.visitGroupId))
    .map((o) => ({ ...o, session: o.mode === 'urgent' ? null : bookingSession({ slot: o.slot, preferredStartAt: o.busyStart, preferredEndAt: o.busyEnd }) }));
  const running = orders.filter((o) => o.status !== 'completed');

  // Arrival end is not repair completion. An order being travelled to or repaired
  // remains busy across sessions/dates. For a future scheduled visit, retain the
  // session rules rather than projecting today's execution state indefinitely.
  if ((mode === 'urgent' || start.getTime() <= now) &&
      running.some((o) => o.status === 'en_route' || o.status === 'under_repair'
        || (mode === 'scheduled' && o.status === 'accepted' && o.mode === 'urgent'))) {
    // A same-evening appointment cannot be accepted while another urgent
    // invitation has already been accepted, even before the technician departs.
    return fail('Technician is on another job');
  }

  if (mode === 'urgent') {
    // Come now: not while on another job, nor during a session whose scheduled job is not done.
    if (running.some((o) => o.status === 'accepted' && (o.mode === 'urgent' || !o.session || sameSession(o.session, slotAt(new Date(now)))))) {
      return fail('Technician is on another job');
    }
    const current = slotAt(new Date(now));
    if (current && running.some((o) => sameSession(o.session, current))) return fail('Scheduled job in this session is not done');
  } else if (session) {
    if (orders.some((o) => sameSession(o.session, session))) return fail('Session already booked');
    // Older bookings without a session still block by their own window.
    const legacy = running.filter((o) => !o.session && o.mode !== 'urgent' && o.busyStart && o.busyEnd)
      .map((o) => ({ start: new Date(o.busyStart!), end: new Date(o.busyEnd!) }));
    if (legacy.length && !hasAvailableArrival(window, schedules, legacy)) return fail('Assignment schedule conflict');
  } else {
    if (running.some((o) => o.busyStart == null || o.busyEnd == null)) return fail('Assignment schedule conflict');
    const busy = running.filter((o) => new Date(o.busyStart!) < end && new Date(o.busyEnd!) > arrivalStart)
      .map((o) => ({ start: new Date(o.busyStart!), end: new Date(o.busyEnd!) }));
    if (busy.length && !hasAvailableArrival(window, schedules, busy)) return fail('Assignment schedule conflict');
  }
  if (keeping) return { eligible: true };

  if (booking.latitudeSnapshot == null || booking.longitudeSnapshot == null) return fail('Booking location is missing');
  const address = bulk ? bulk.addresses.get(technicianId) ?? null : await manager.findOneBy(Address, { userId: technicianId, isDefault: true });
  const gpsConfig = bulk ? null : await manager.findOneBy(SystemConfig, { key: 'matching.gps_fresh_minutes' });
  const origin = technicianOrigin(mode, profile, address, bulk ? bulk.gpsFreshMinutes : gpsConfig ? Number(gpsConfig.value) : 15, now);
  if (!origin) return fail('Technician location is missing');
  if (origin.source === 'address') {
    const areas = bulk ? bulk.areas.get(profile.id) ?? [] : await manager.find(TechnicianServiceArea, { where: { technicianId: profile.id } });
    if (!servesArea(areas, booking)) return fail('Outside technician service areas');
  }
  const distanceKm = distanceToBooking(origin, booking);
  if (distanceKm == null || distanceKm > Number(profile.serviceRadiusKm)) return fail('Outside technician service radius');
  return { eligible: true };
}

/**
 * The error code for an eligibility failure. Only a locked, inactive or
 * work-suspended technician is WORK_SUSPENDED; outside working hours, time off,
 * a clash, the wallet minimum or distance are TECHNICIAN_NOT_ELIGIBLE, so the
 * client can say what actually stands in the way.
 */
export function eligibilityErrorCode(reason: string | undefined): ErrorCode {
  return reason === 'Technician account is not active' || reason === 'Technician is unavailable or suspended'
    ? ErrorCodes.WORK_SUSPENDED
    : ErrorCodes.TECHNICIAN_NOT_ELIGIBLE;
}

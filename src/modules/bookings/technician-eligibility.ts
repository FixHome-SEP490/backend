import { EntityManager } from 'typeorm';
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
  },
): Promise<{ eligible: boolean; reason?: string }> {
  const keeping = options?.keepingExistingOrder === true;
  const fail = (reason: string) => ({ eligible: false, reason });
  const user = await manager.findOneBy(User, { id: technicianId });
  if (!user || user.role !== Role.TECHNICIAN || user.status !== AccountStatus.ACTIVE) return fail('Technician account is not active');
  const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianId });
  if (!profile || profile.verificationStatus !== VerificationStatus.VERIFIED) return fail('Technician is not verified');
  if (profile.workSuspendedUntil && profile.workSuspendedUntil > new Date()) return fail('Technician is unavailable or suspended');
  if (!profile.isAvailable && !options?.allowPausedExistingInvitation && !keeping) return fail('Technician is unavailable or paused');
  if (!keeping && !await manager.findOneBy(TechnicianSkill, { technicianId: profile.id, serviceId: booking.serviceId, isActive: true, verificationStatus: VerificationStatus.VERIFIED })) return fail('Service is not offered or not yet verified');
  if (!keeping && await manager.count(CommissionDue, { where: { technicianId, status: CommissionDueStatus.PENDING } })) return fail('Active unpaid PlatformDue');
  const wallet = keeping ? null : await manager.findOneBy(Wallet, { technicianId });
  if (wallet) {
    const minConfig = await manager.findOneBy(SystemConfig, { key: 'wallet.minimum_balance' });
    const minimumBalance = minConfig ? Number(minConfig.value) : 200000;
    if (Number(wallet.balance) < minimumBalance) {
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
  const schedules = await manager.find(TechnicianSchedule, { where: { technicianId: profile.id } });
  const timeOff = await manager.createQueryBuilder(TechnicianTimeOff, 't')
    .where('t.technicianId = :id', { id: profile.id })
    .andWhere('t.startAt < :end AND t.endAt > :start', { start: arrivalStart, end }).getMany();
  if (timeOff.length) return fail('Technician has time off');
  if (!hasAvailableArrival(window, schedules, [])) return fail('Outside working schedule');

  // Every order the technician holds that is not cancelled, completed ones included:
  // a session counts as taken even after its order is done (one scheduled booking per session).
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
  const orders = (await held.getRawMany<{ orderId: string; status: string; slot: string | null; mode: string | null; busyStart: Date | string | null; busyEnd: Date | string | null }>())
    .map((o) => ({ ...o, session: o.mode === 'urgent' ? null : bookingSession({ slot: o.slot, preferredStartAt: o.busyStart, preferredEndAt: o.busyEnd }) }));
  const running = orders.filter((o) => o.status !== 'completed');

  if (mode === 'urgent') {
    // Come now: not while on another job, nor during a session whose scheduled job is not done.
    if (running.some((o) => ['accepted', 'en_route', 'under_repair'].includes(o.status) && (o.mode === 'urgent' || !o.session || sameSession(o.session, slotAt(new Date(now)))))) {
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
  const address = await manager.findOneBy(Address, { userId: technicianId, isDefault: true });
  const gpsConfig = await manager.findOneBy(SystemConfig, { key: 'matching.gps_fresh_minutes' });
  const origin = technicianOrigin(mode, profile, address, gpsConfig ? Number(gpsConfig.value) : 15, now);
  if (!origin) return fail('Technician location is missing');
  if (origin.source === 'address') {
    const areas = await manager.find(TechnicianServiceArea, { where: { technicianId: profile.id } });
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

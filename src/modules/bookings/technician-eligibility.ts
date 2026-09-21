import { EntityManager } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSchedule } from '../technicians/entities/technician-schedule.entity';
import { TechnicianTimeOff } from '../technicians/entities/technician-time-off.entity';
import { TechnicianServiceArea } from '../technicians/entities/technician-service-area.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { AccountStatus, CommissionDueStatus, Role, VerificationStatus } from '../../shared/enums';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { hasAvailableArrival, type ArrivalInterval } from './arrival-window';

/** Same authority at discovery, shortlist, activation and Accept. IDs here are User IDs. */
export async function technicianEligibility(
  manager: EntityManager, technicianId: string, booking: Booking,
  excludeOrderId?: string,
  options?: { allowPausedExistingInvitation?: boolean },
): Promise<{ eligible: boolean; reason?: string }> {
  const fail = (reason: string) => ({ eligible: false, reason });
  const user = await manager.findOneBy(User, { id: technicianId });
  if (!user || user.role !== Role.TECHNICIAN || user.status !== AccountStatus.ACTIVE) return fail('Technician account is not active');
  const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianId });
  if (!profile || profile.verificationStatus !== VerificationStatus.VERIFIED) return fail('Technician is not verified');
  if (profile.workSuspendedUntil && profile.workSuspendedUntil > new Date()) return fail('Technician is unavailable or suspended');
  if (!profile.isAvailable && !options?.allowPausedExistingInvitation) return fail('Technician is unavailable or paused');
  if (!await manager.findOneBy(TechnicianSkill, { technicianId: profile.id, serviceId: booking.serviceId, isActive: true, verificationStatus: VerificationStatus.VERIFIED })) return fail('Service is not offered or not yet verified');
  if (await manager.count(CommissionDue, { where: { technicianId, status: CommissionDueStatus.PENDING } })) return fail('Active unpaid PlatformDue');
  if (!booking.preferredStartAt || !booking.preferredEndAt) return fail('Booking time window is missing');
  const start = new Date(booking.preferredStartAt);
  const end = new Date(booking.preferredEndAt);
  const now = Date.now();
  if (!(start < end) || end.getTime() <= now) return fail('Booking time window is invalid or expired');
  const arrivalStart = new Date(Math.max(start.getTime(), now));
  const schedules = await manager.find(TechnicianSchedule, { where: { technicianId: profile.id } });
  const timeOff = await manager.createQueryBuilder(TechnicianTimeOff, 't')
    .where('t.technicianId = :id', { id: profile.id })
    .andWhere('t.startAt < :end AND t.endAt > :start', { start: arrivalStart, end }).getMany();
  const conflict = await manager.createQueryBuilder('technician_assignments', 'a')
    .select('b.preferred_start_at', 'busyStart')
    .addSelect('b.preferred_end_at', 'busyEnd')
    .innerJoin('service_orders', 'o', 'o.id = a.service_order_id')
    .innerJoin('bookings', 'b', 'b.id = o.booking_id')
    .where('a.technician_id = :id AND a.is_active = true', { id: technicianId })
    .andWhere('o.status NOT IN (:...terminal)', { terminal: ['completed', 'cancelled'] })
    .andWhere('(b.preferred_start_at IS NULL OR b.preferred_end_at IS NULL OR (b.preferred_start_at < :end AND b.preferred_end_at > :start))', { start: arrivalStart, end });
  if (excludeOrderId) conflict.andWhere('o.id != :excludeOrderId', { excludeOrderId });
  const assignments = await conflict.getRawMany<{
    busyStart: Date | string | null;
    busyEnd: Date | string | null;
  }>();
  if (assignments.some(assignment => assignment.busyStart == null || assignment.busyEnd == null)) {
    return fail('Assignment schedule conflict');
  }

  const window: ArrivalInterval = { start: arrivalStart, end };
  if (!hasAvailableArrival(window, schedules, [])) return fail('Outside working schedule');
  const timeOffIntervals = timeOff.map(interval => ({
    start: interval.startAt,
    end: interval.endAt,
  }));
  const assignmentIntervals = assignments.map(assignment => ({
    start: assignment.busyStart instanceof Date ? assignment.busyStart : new Date(assignment.busyStart!),
    end: assignment.busyEnd instanceof Date ? assignment.busyEnd : new Date(assignment.busyEnd!),
  }));
  const unavailable = [...timeOffIntervals, ...assignmentIntervals];
  if (!hasAvailableArrival(window, schedules, unavailable)) {
    if (timeOffIntervals.length && !hasAvailableArrival(window, schedules, timeOffIntervals)) {
      return fail('Technician has time off');
    }
    if (assignmentIntervals.length && !hasAvailableArrival(window, schedules, assignmentIntervals)) {
      return fail('Assignment schedule conflict');
    }
    return fail('No available arrival interval');
  }
  if (!booking.provinceSnapshot && !booking.districtSnapshot && !booking.addressId) return fail('Service area snapshot is missing');
  const targetArea = resolveServiceArea({
    province: booking.provinceSnapshot,
    district: booking.districtSnapshot,
  });
  const areas = await manager.find(TechnicianServiceArea, { where: { technicianId: profile.id } });
  const inArea = areas.some(area => {
    const provMatch = area.provinceCode === targetArea.provinceCode || area.provinceCode === booking.provinceSnapshot;
    const distMatch = area.districtCode === targetArea.districtCode ||
                      targetArea.districtAliasCodes.includes(area.districtCode) ||
                      area.districtCode === booking.districtSnapshot;
    return provMatch && distMatch;
  });
  if (!inArea) return fail('Outside service area');
  return { eligible: true };
}

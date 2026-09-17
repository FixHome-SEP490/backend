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

/** Same authority at discovery, shortlist, activation and Accept. IDs here are User IDs. */
export async function technicianEligibility(
  manager: EntityManager, technicianId: string, booking: Booking,
  excludeOrderId?: string,
): Promise<{ eligible: boolean; reason?: string }> {
  const fail = (reason: string) => ({ eligible: false, reason });
  const user = await manager.findOneBy(User, { id: technicianId });
  if (!user || user.role !== Role.TECHNICIAN || user.status !== AccountStatus.ACTIVE) return fail('Technician account is not active');
  const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianId });
  if (!profile || profile.verificationStatus !== VerificationStatus.VERIFIED) return fail('Technician is not verified');
  if (!profile.isAvailable || (profile.workSuspendedUntil && profile.workSuspendedUntil > new Date())) return fail('Technician is unavailable or suspended');
  if (!await manager.findOneBy(TechnicianSkill, { technicianId: profile.id, serviceId: booking.serviceId, isActive: true })) return fail('Service is not offered');
  if (await manager.count(CommissionDue, { where: { technicianId, status: CommissionDueStatus.PENDING } })) return fail('Active unpaid PlatformDue');
  if (!booking.preferredStartAt || !booking.preferredEndAt) return fail('Booking time window is missing');
  const start = new Date(booking.preferredStartAt);
  const end = new Date(booking.preferredEndAt);
  if (!(start < end) || end <= new Date()) return fail('Booking time window is invalid or expired');
  // Working schedules are local Vietnam wall-clock times (UTC+7); intervals must fit one day.
  const localStart = new Date(start.getTime() + 7 * 3600000);
  const localEnd = new Date(end.getTime() + 7 * 3600000);
  if (localStart.toISOString().slice(0, 10) !== localEnd.toISOString().slice(0, 10)) return fail('Time window crosses working days');
  const schedules = await manager.find(TechnicianSchedule, { where: { technicianId: profile.id, dayOfWeek: localStart.getUTCDay() } });
  const from = localStart.toISOString().slice(11, 16);
  const to = localEnd.toISOString().slice(11, 16);
  if (!schedules.some(s => s.startTime.slice(0, 5) <= from && s.endTime.slice(0, 5) >= to)) return fail('Outside working schedule');
  const timeOff = await manager.createQueryBuilder(TechnicianTimeOff, 't')
    .where('t.technicianId = :id', { id: profile.id })
    .andWhere('t.startAt < :end AND t.endAt > :start', { start, end }).getCount();
  if (timeOff) return fail('Technician has time off');
  const conflict = await manager.createQueryBuilder('technician_assignments', 'a')
    .innerJoin('service_orders', 'o', 'o.id = a.service_order_id')
    .innerJoin('bookings', 'b', 'b.id = o.booking_id')
    .where('a.technician_id = :id AND a.is_active = true', { id: technicianId })
    .andWhere('o.status NOT IN (:...terminal)', { terminal: ['completed', 'cancelled'] })
    .andWhere('(b.preferred_start_at IS NULL OR b.preferred_end_at IS NULL OR (b.preferred_start_at < :end AND b.preferred_end_at > :start))', { start, end });
  if (excludeOrderId) conflict.andWhere('o.id != :excludeOrderId', { excludeOrderId });
  if (await conflict.getCount()) return fail('Assignment schedule conflict');
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

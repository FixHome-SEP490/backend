import { isUUID } from 'class-validator';
import type { EntityManager } from 'typeorm';
import { Role } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';

export const SOLO_CONTACT = 'SOLO_CONTACT_ATTEMPT';

export function contactReadiness(callTimes: number[], notified: boolean, now: number) {
  const calls = callTimes.filter(time => Number.isFinite(time) && time <= now).sort((a, b) => a - b);
  const first = calls[0];
  const spaced = calls.length >= 2 && calls[calls.length - 1] - first >= 300000;
  return { contactCount: calls.length, notificationSent: notified, callsSpaced: spaced,
    nextCallAt: first === undefined ? null : new Date(first + 300000).toISOString(),
    nextEligibleAt: first === undefined ? null : new Date(first + 600000).toISOString(),
    serverNow: new Date(now).toISOString(), ready: spaced && notified && now - first >= 600000 };
}

export async function soloContactEvidence(manager: EntityManager,
  current: { order: ServiceOrder; booking: Booking; assignment: TechnicianAssignment; checkin: ArrivalCheckIn }, actor: { id: string }, now = Date.now(), evidenceIds?: string[]) {
  const rows = await manager.find(AuditLog, { where: { action: SOLO_CONTACT, resourceType: 'service_order',
    resourceId: current.order.id, actorUserId: actor.id, actorRole: Role.TECHNICIAN }, order: { createdAt: 'ASC' } });
  const valid = rows.filter(row => (!evidenceIds || evidenceIds.includes(row.id)) && row.after?.version === 1 &&
    ['CALL_ATTEMPT', 'IN_APP_NOTIFICATION'].includes(row.after.kind as string) && row.after.origin === 'TECHNICIAN_CONTACT_ACTION' &&
    row.after.assignmentId === current.assignment.id && row.after.checkInId === current.checkin.id &&
    row.after.orderId === current.order.id && row.after.customerId === current.booking.customerId &&
    new Date(row.createdAt).getTime() >= new Date(current.checkin.checkedInAt).getTime() && new Date(row.createdAt).getTime() <= now);
  let notified = false;
  for (const row of valid.filter(row => row.after?.kind === 'IN_APP_NOTIFICATION')) {
    const notification = typeof row.after?.notificationId === 'string' && isUUID(row.after.notificationId, '4') && await manager.findOneBy(Notification, {
      id: row.after.notificationId, userId: current.booking.customerId, type: SOLO_CONTACT,
      referenceType: 'SERVICE_ORDER', referenceId: current.order.id,
    });
    if (notification && new Date(notification.createdAt).getTime() >= new Date(current.checkin.checkedInAt).getTime() &&
      new Date(notification.createdAt).getTime() <= now) notified = true;
  }
  return { rows: valid, readiness: contactReadiness(valid.filter(row => row.after?.kind === 'CALL_ATTEMPT')
    .map(row => new Date(row.createdAt).getTime()), notified, now) };
}

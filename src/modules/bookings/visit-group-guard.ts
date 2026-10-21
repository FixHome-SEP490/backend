import { EntityManager, In, Not } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus } from '../../shared/enums';
import { Booking } from './entities/booking.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';

/**
 * A booking that is one device of a VisitGroup (PO 21/10/2026) is matched,
 * rescheduled and cancelled together with its group, never on its own: one
 * technician takes the whole visit, so a lone shortlist or schedule change on
 * one device would split the visit without the customer asking for it.
 */
export function refuseLoneGroupedBookingAction(booking: { visitGroupId?: string | null }): void {
  if (booking.visitGroupId) {
    throw new BusinessException(
      ErrorCodes.ORDER_INVALID_TRANSITION,
      'Thiết bị này thuộc một lượt sửa nhiều máy, thao tác này làm trên cả lượt.',
      { visitGroupId: booking.visitGroupId },
    );
  }
}

/**
 * The other devices of a booking's visit, in id order (the lock order every
 * group command uses). Empty for a booking outside any group. Cancelled
 * devices are left out: they no longer travel with the visit.
 */
export async function groupSiblings(
  manager: EntityManager,
  booking: { id: string; visitGroupId?: string | null },
  lock = false,
): Promise<Booking[]> {
  if (!booking.visitGroupId) return [];
  return manager.find(Booking, {
    where: { visitGroupId: booking.visitGroupId, id: Not(booking.id), status: Not(BookingStatus.CANCELLED) },
    order: { id: 'ASC' },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
}

/**
 * Matching runs on the visit's lead booking (its first device); the other
 * devices follow its status so every screen that reads one device tells the
 * same story as the visit.
 */
export async function mirrorGroupStatus(
  manager: EntityManager,
  booking: { id: string; visitGroupId?: string | null },
  status: BookingStatus,
): Promise<void> {
  const siblings = await groupSiblings(manager, booking);
  if (siblings.length) await manager.update(Booking, { id: In(siblings.map((sibling) => sibling.id)) }, { status });
}

/** Every service the visit needs, so one technician is matched for all of them. */
export async function groupServiceIds(manager: EntityManager, booking: { serviceId: string; visitGroupId?: string | null }): Promise<string[]> {
  if (!booking.visitGroupId) return [booking.serviceId];
  const rows = await manager.find(Booking, {
    select: { id: true, serviceId: true },
    where: { visitGroupId: booking.visitGroupId, status: Not(BookingStatus.CANCELLED) },
  });
  return [...new Set([booking.serviceId, ...rows.map((row) => row.serviceId)])];
}

/** One device of a visit as a technician's invitation shows it. */
export interface VisitDevice {
  sequence: number;
  deviceLabel: string | null;
  booking: Booking;
}

/**
 * The devices of every visit among `bookings`, keyed by the booking asked
 * about, in the order the customer listed them. Bookings outside a visit are
 * not in the map.
 */
export async function visitDevicesOf(manager: EntityManager, bookings: Array<{ id: string; visitGroupId?: string | null }>): Promise<Map<string, VisitDevice[]>> {
  const groupIds = [...new Set(bookings.map((booking) => booking.visitGroupId).filter((id): id is string => !!id))];
  const result = new Map<string, VisitDevice[]>();
  if (!groupIds.length) return result;
  const items = await manager.find(VisitGroupItem, { where: { groupId: In(groupIds) }, order: { sequence: 'ASC' } });
  const children = await manager.find(Booking, {
    where: { id: In(items.map((item) => item.bookingId)), status: Not(BookingStatus.CANCELLED) },
    relations: ['media'],
    relationLoadStrategy: 'query',
  });
  const byId = new Map(children.map((child) => [child.id, child]));
  for (const booking of bookings) {
    if (!booking.visitGroupId) continue;
    result.set(booking.id, items
      .filter((item) => item.groupId === booking.visitGroupId && byId.has(item.bookingId))
      .map((item) => ({ sequence: item.sequence, deviceLabel: item.deviceLabel ?? null, booking: byId.get(item.bookingId)! })));
  }
  return result;
}

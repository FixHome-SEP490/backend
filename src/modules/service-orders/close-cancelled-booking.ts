import { EntityManager, In } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { BookingStatus, InvitationStatus } from '../../shared/enums';

/**
 * A booking has at most one ServiceOrder, so once that order is cancelled the
 * booking is over too. Every path that cancels an order must call this, or the
 * booking stays MATCHED: the customer cannot cancel it and the next invited
 * technician is told someone already took it.
 */
export async function closeBookingForCancelledOrder(manager: EntityManager, bookingId: string): Promise<void> {
  await manager.update(Booking, bookingId, { status: BookingStatus.CANCELLED });
  await manager.update(
    BookingInvitation,
    { bookingId, status: In([InvitationStatus.PENDING, InvitationStatus.STANDBY]) },
    { status: InvitationStatus.CANCELLED, respondedAt: new Date() },
  );
}

/**
 * When an accepted order counts as a no-show: the end of the customer's window
 * plus the grace period, but never earlier than the technician's acceptance
 * plus the grace period. Counting from the start of the window cancelled
 * orders the moment a late invitee accepted them.
 */
export function overdueDeadline(
  windowEnd: Date | null | undefined,
  scheduledAt: Date | null | undefined,
  acceptedAt: Date,
  graceMinutes: number,
): Date | null {
  const end = windowEnd ?? scheduledAt;
  if (!end) return null;
  const from = Math.max(new Date(end).getTime(), new Date(acceptedAt).getTime());
  return new Date(from + graceMinutes * 60_000);
}

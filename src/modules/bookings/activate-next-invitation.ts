import { EntityManager } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingStatus, InvitationStatus } from '../../shared/enums';
import { technicianEligibility } from './technician-eligibility';

/**
 * Runs when an invitation is handed to the next technician in the shortlist.
 * Spec 8.6 opens the conversation at exactly this moment -- the technician has
 * received the booking -- so the hook lives inside the same transaction and the
 * thread can never exist without its invitation, or the other way round.
 */
export type OnInvitationActivated = (
  manager: EntityManager,
  booking: Booking,
  technicianId: string,
) => Promise<void>;

/** Caller holds the Booking row lock for the whole decision. */
export async function activateNextInvitation(
  manager: EntityManager,
  booking: Booking,
  ttl: number,
  onActivated?: OnInvitationActivated,
): Promise<void> {
    if (booking.status !== BookingStatus.MATCHING) return;
    if (await manager.findOneBy(BookingInvitation, { bookingId: booking.id, status: InvitationStatus.PENDING })) return;
    const standby = await manager.find(BookingInvitation, { where: { bookingId: booking.id, status: InvitationStatus.STANDBY }, order: { priorityOrder: 'ASC' } });
    for (const invitation of standby) {
      if (!(await technicianEligibility(manager, invitation.technicianId, booking)).eligible) {
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: new Date() });
        continue;
      }
      await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.PENDING, invitedAt: new Date(), expiresAt: new Date(Date.now() + ttl * 60000) });
      await onActivated?.(manager, booking, invitation.technicianId);
      return;
    }
    await manager.update(Booking, booking.id, { status: BookingStatus.CLOSED });
}

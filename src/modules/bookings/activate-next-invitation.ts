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
    // A shortlist is one simultaneous round: all eligible technicians get the same deadline.
    // The caller holds the Booking row lock, so the round cannot race with Accept/cancel.
    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + ttl * 60000);
    let activated = false;
    for (const invitation of standby) {
      if (!(await technicianEligibility(manager, invitation.technicianId, booking)).eligible) {
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: new Date() });
        continue;
      }
      await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.PENDING, invitedAt, expiresAt });
      await onActivated?.(manager, booking, invitation.technicianId);
      activated = true;
    }
    if (!activated) await manager.update(Booking, booking.id, { status: BookingStatus.CLOSED });
}

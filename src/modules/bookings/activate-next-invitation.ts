import { EntityManager } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { BookingStatus, InvitationStatus } from '../../shared/enums';
import { technicianEligibility } from './technician-eligibility';
/** Caller holds the Booking row lock for the whole decision. */
export async function activateNextInvitation(manager: EntityManager, booking: Booking, ttl: number): Promise<void> {
    if (booking.status !== BookingStatus.MATCHING) return;
    if (await manager.findOneBy(BookingInvitation, { bookingId: booking.id, status: InvitationStatus.PENDING })) return;
    const standby = await manager.find(BookingInvitation, { where: { bookingId: booking.id, status: InvitationStatus.STANDBY }, order: { priorityOrder: 'ASC' } });
    for (const invitation of standby) {
      if (!(await technicianEligibility(manager, invitation.technicianId, booking)).eligible) {
        await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.EXPIRED, respondedAt: new Date() });
        continue;
      }
      await manager.update(BookingInvitation, invitation.id, { status: InvitationStatus.PENDING, invitedAt: new Date(), expiresAt: new Date(Date.now() + ttl * 60000) });
      return;
    }
    await manager.update(Booking, booking.id, { status: BookingStatus.CLOSED });
}

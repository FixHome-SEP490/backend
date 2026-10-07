import { EntityManager } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { Conversation } from './entities/conversation.entity';
import { ConversationStatus } from '../../shared/enums';

/**
 * The booking's conversation with one technician, created if it does not
 * exist yet. Idempotent. A plain function so every path that hands an
 * invitation to a technician (first round, rematch after a withdrawal or a
 * reschedule, the background sweep) opens the thread the same way.
 */
export async function ensureBookingConversation(
  manager: EntityManager,
  booking: Booking,
  technicianId: string,
): Promise<Conversation> {
  const existing = await manager.findOneBy(Conversation, { bookingId: booking.id, technicianId });
  if (existing) return existing;
  return manager.save(Conversation, manager.create(Conversation, {
    bookingId: booking.id,
    customerId: booking.customerId,
    technicianId,
    status: ConversationStatus.ACTIVE,
    serviceNameSnapshot: booking.serviceNameSnapshot ?? null,
  }));
}

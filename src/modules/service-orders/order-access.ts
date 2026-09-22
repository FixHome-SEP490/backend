import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { Role } from '../../shared/enums';

export type OrderActor = { id: string; role: string };

/** Read access never grants permission to perform another actor's command. */
export async function authorizeOrder(
  manager: EntityManager,
  orderId: string,
  actor: OrderActor,
  command: 'read' | 'customer' | 'technician' = 'read',
  lock = false,
): Promise<ServiceOrder> {
  const order = await manager.findOne(ServiceOrder, {
    where: { id: orderId },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  if (!order) throw new ForbiddenException('Order not found or access denied');
  if (command === 'read' && [Role.ADMIN, Role.SERVICE_MANAGER].includes(actor.role as Role)) {
    return order;
  }
  if (actor.role === Role.CUSTOMER && command !== 'technician') {
    const booking = await manager.findOneBy(Booking, { id: order.bookingId, customerId: actor.id });
    if (booking) return order;
  }
  if (actor.role === Role.TECHNICIAN && command !== 'customer') {
    const assignment = await manager.findOneBy(TechnicianAssignment, {
      serviceOrderId: orderId,
      technicianId: actor.id,
      isActive: true,
    });
    if (assignment) return order;
  }
  throw new ForbiddenException('Order not found or access denied');
}

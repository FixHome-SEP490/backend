import type { EntityManager } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Notification } from './entities/notification.entity';

/**
 * ORDER_COMPLETED for the customer and the technician holding the order.
 * An order completes on whichever comes last: the customer's confirmation,
 * the cash settlement (customer or Service Manager) or the online payment, so
 * every one of those paths calls this inside its own transaction; the notices
 * commit or roll back with the completion itself.
 */
export async function recordOrderCompletedNotices(
  manager: EntityManager,
  order: { id: string; code: string; bookingId: string },
  warrantyStarted: boolean,
): Promise<void> {
  const booking = await manager.findOne(Booking, { where: { id: order.bookingId }, select: { id: true, customerId: true } });
  const assignment = await manager.findOne(TechnicianAssignment, { where: { serviceOrderId: order.id, isActive: true } });
  const rows: Partial<Notification>[] = [];
  if (booking?.customerId) {
    rows.push({
      userId: booking.customerId,
      title: 'Đơn sửa chữa đã hoàn tất',
      message: `Đơn #${order.code} đã hoàn tất.${warrantyStarted ? ' Thời hạn bảo hành của đơn bắt đầu tính từ hôm nay.' : ''} Bạn có thể đánh giá kỹ thuật viên trong chi tiết đơn.`,
      type: 'ORDER_COMPLETED',
      referenceId: order.id,
      referenceType: 'SERVICE_ORDER',
      isRead: false,
    });
  }
  if (assignment?.technicianId) {
    rows.push({
      userId: assignment.technicianId,
      title: 'Đơn đã hoàn tất',
      message: `Đơn #${order.code} đã hoàn tất và đã thanh toán. Xem tiền công và phí nền tảng ở mục Thu nhập.`,
      type: 'ORDER_COMPLETED',
      referenceId: order.id,
      referenceType: 'SERVICE_ORDER',
      isRead: false,
    });
  }
  if (rows.length) await manager.insert(Notification, rows);
}

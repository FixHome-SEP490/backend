import { In, Not, type EntityManager } from 'typeorm';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { CheckInResult, ServiceOrderStatus } from '../../shared/enums';

/**
 * PO 20/10/2026: thợ đang ở một đơn (đã check-in hoặc đang sửa) mà đơn kế tiếp
 * sắp tới giờ thì được nhả đơn kế tiếp, không bị trừ điểm. Ngưỡng "sắp tới giờ"
 * nằm ở cấu hình `matching.overrun_release_window_minutes` (mặc định 180 phút).
 */
export const OVERRUN_RELEASE_WINDOW_KEY = 'matching.overrun_release_window_minutes';
export const OVERRUN_RELEASE_WINDOW_DEFAULT_MINUTES = 180;

export type OverrunReleaseBlock =
  | 'NOT_ASSIGNED'
  | 'ORDER_NOT_WAITING'
  | 'ALREADY_ARRIVED'
  | 'NO_CURRENT_JOB'
  | 'NOT_STARTING_SOON';

export interface OverrunReleaseCheck {
  eligible: boolean;
  block: OverrunReleaseBlock | null;
  /** Mã đơn thợ đang làm, để thợ và khách hiểu vì sao. */
  currentOrderCode: string | null;
  /** Đơn thợ đang làm: app mở đúng biểu mẫu báo cáo; báo cáo có ảnh chỉ nhận khi đơn đó đang sửa. */
  currentOrderId: string | null;
  currentOrderStatus: ServiceOrderStatus | null;
  windowMinutes: number;
}

export async function checkOverrunRelease(
  manager: EntityManager,
  order: ServiceOrder,
  technicianId: string,
  windowMinutes: number,
  now: Date = new Date(),
): Promise<OverrunReleaseCheck> {
  const result = (block: OverrunReleaseBlock | null, current: ServiceOrder | null = null): OverrunReleaseCheck =>
    ({ eligible: block === null, block, currentOrderCode: current?.code ?? null, currentOrderId: current?.id ?? null,
      currentOrderStatus: current?.status ?? null, windowMinutes });

  const assignment = await manager.findOneBy(TechnicianAssignment, { serviceOrderId: order.id, technicianId, isActive: true });
  if (!assignment) return result('NOT_ASSIGNED');
  if (![ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.EN_ROUTE].includes(order.status)) return result('ORDER_NOT_WAITING');
  if (await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: order.id, technicianId, result: CheckInResult.VALID })) {
    return result('ALREADY_ARRIVED');
  }

  // Đơn đang làm: đang sửa, hoặc đã check-in tại nhà khách.
  const others = await manager.find(TechnicianAssignment, { where: { technicianId, isActive: true, serviceOrderId: Not(order.id) } });
  const candidates = others.length
    ? await manager.find(ServiceOrder, { where: { id: In(others.map(a => a.serviceOrderId)), status: In([ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR]) } })
    : [];
  let current: ServiceOrder | null = candidates.find(o => o.status === ServiceOrderStatus.UNDER_REPAIR) ?? null;
  if (!current) {
    for (const candidate of candidates) {
      if (await manager.findOneBy(ArrivalCheckIn, { serviceOrderId: candidate.id, technicianId, result: CheckInResult.VALID })) {
        current = candidate;
        break;
      }
    }
  }
  if (!current) return result('NO_CURRENT_JOB');

  const booking = await manager.findOneBy(Booking, { id: order.bookingId });
  const start = booking?.preferredStartAt ? new Date(booking.preferredStartAt).getTime() : null;
  if (start === null || start > now.getTime() + windowMinutes * 60_000) return result('NOT_STARTING_SOON', current);
  return result(null, current);
}

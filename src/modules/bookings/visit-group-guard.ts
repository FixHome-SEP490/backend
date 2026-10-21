import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';

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

import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { CostItemType } from '../../shared/enums';

/**
 * A fixed-price device of a visit is quoted on site so the customer approves
 * each device (PO 21/10/2026, G0-1 1B), but the quote keeps the catalog price
 * the customer booked: labour only, adding up to that price. Anything extra
 * found on site goes through an additional cost after approval.
 */
export function assertFixedPriceQuote(
  items: Array<{ type: CostItemType; quantity: number; unitPrice: number }>,
  booking: { fixedUnitPriceSnapshot?: string | number | null; quantity?: number | null },
): void {
  const price = booking.fixedUnitPriceSnapshot == null ? NaN : Number(booking.fixedUnitPriceSnapshot) * (booking.quantity ?? 1);
  const labor = items.filter((item) => item.type === CostItemType.LABOR).reduce((total, item) => total + item.quantity * item.unitPrice, 0);
  if (!Number.isFinite(price) || items.some((item) => item.type !== CostItemType.LABOR) || labor !== price) {
    throw new BusinessException(
      ErrorCodes.VALIDATION_FAILED,
      `Thiết bị giá cố định báo đúng tiền công ${Math.round(price).toLocaleString('vi-VN')}đ; linh kiện hay việc phát sinh gửi sau khi khách duyệt.`,
    );
  }
}

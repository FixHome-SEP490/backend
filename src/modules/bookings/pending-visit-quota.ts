import { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';

/** Acquire before Booking/group/order/technician locks, including ambient rebook transactions. */
export async function lockPendingVisitCustomer(manager: EntityManager, customerId: string): Promise<void> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new BusinessException(ErrorCodes.CONFLICT, 'Không xác minh được giao dịch đặt lịch.');
  }
  const rows = await manager.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [customerId]);
  if (rows.length !== 1) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy khách hàng.');
}

/**
 * Caller holds the customer lock until commit. Separate statement after FOR UPDATE is essential:
 * PostgreSQL READ COMMITTED must take a fresh snapshot after waiting for the previous writer.
 * Exclude the logical visit being changed; a still-pending visit consumes no additional slot.
 * Only group creation may bypass child checks, after checking once for the new parent.
 */
export async function checkPendingVisitQuota(
  manager: EntityManager, customerId: string, logicalVisitId: string | null = null, reject = true,
): Promise<boolean> {
  const rows = await manager.query(`
    SELECT COUNT(DISTINCT COALESCE(b.visit_group_id, b.id))::int AS pending
    FROM bookings b
    WHERE b.customer_id = $1
      AND b.status IN ('submitted', 'matching') AND b.preferred_end_at > now()
      AND ($2::uuid IS NULL OR COALESCE(b.visit_group_id, b.id) <> $2::uuid)
  `, [customerId, logicalVisitId ?? null]);
  const pending = rows[0]?.pending;
  if (!Number.isInteger(pending) || pending < 0) {
    throw new BusinessException(ErrorCodes.CONFLICT, 'Không xác minh được số yêu cầu đang chờ.');
  }
  if (pending < 2) return true;
  if (reject) throw new BusinessException(ErrorCodes.PENDING_VISIT_LIMIT_REACHED,
    'Bạn đang có hai lượt sửa chữa chờ kỹ thuật viên nhận. Vui lòng chờ hoặc hủy một yêu cầu trước khi tiếp tục.',
    { limit: 2, remaining: 0 });
  return false;
}

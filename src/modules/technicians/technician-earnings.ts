import { EntityManager } from 'typeorm';
import { ServiceOrderStatus } from '../../shared/enums';

export interface CompletedOrderEarning {
  orderId: string;
  code: string | null;
  completedAt: Date | null;
  customerName: string | null;
  laborTotal: number;
  commission: number;
}

/**
 * The labour a technician earned on orders they completed, read from the
 * issued invoice: labour and commission are the amounts snapshotted there
 * (BRX-026), never a hard-coded 10%, and parts never enter it. Only orders the
 * technician still held when they were completed count; a technician who was
 * replaced keeps none of that order's earnings.
 */
export async function completedOrderEarnings(
  manager: EntityManager,
  technicianId: string,
  since?: Date,
): Promise<CompletedOrderEarning[]> {
  const params: unknown[] = [technicianId, ServiceOrderStatus.COMPLETED];
  if (since) params.push(since);
  const rows: Array<Record<string, unknown>> = await manager.query(
    `SELECT so.id AS "orderId", so.code AS "code", so.completed_at AS "completedAt",
            u.full_name AS "customerName",
            COALESCE(i.labor_total, so.labor_total, 0) AS "laborTotal",
            COALESCE(i.commission_amount, 0) AS "commission"
       FROM technician_assignments ta
       JOIN service_orders so ON so.id = ta.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN users u ON u.id = b.customer_id
       LEFT JOIN invoices i ON i.service_order_id = so.id
      WHERE ta.technician_id = $1 AND ta.is_active = true AND so.status = $2
        ${since ? 'AND so.completed_at >= $3' : ''}
      ORDER BY so.completed_at DESC`,
    params,
  );
  return rows.map((row) => ({
    orderId: String(row.orderId),
    code: (row.code as string | null) ?? null,
    completedAt: row.completedAt ? new Date(row.completedAt as string) : null,
    customerName: (row.customerName as string | null) ?? null,
    laborTotal: Number(row.laborTotal ?? 0),
    commission: Number(row.commission ?? 0),
  }));
}

/** 00:00 on the first day of the current month in Vietnam (UTC+7). */
export function startOfVietnamMonth(now: Date = new Date()): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3_600_000);
}

/** A rating is shown only once there is at least one review. */
export function displayRating(averageRating: unknown, ratingCount: unknown): number | null {
  return Number(ratingCount) > 0 ? Number(averageRating) : null;
}

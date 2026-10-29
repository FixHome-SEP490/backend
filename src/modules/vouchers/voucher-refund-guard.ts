import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * The legacy support-case path refunds against original Invoice.grandTotal.
 * A funded invoice needs the reviewed proportional F3 reversal transaction;
 * until then, it cannot use that original-gross path. Before the additive F4
 * migration exists, no funded link can exist and legacy refunds still work.
 */
export async function assertNoFundedVoucherRefund(
  manager: EntityManager,
  invoiceId: string,
): Promise<void> {
  // A missing relation raises 42P01 and aborts the surrounding refund transaction,
  // even if caught. Check the catalog first; do not try the missing SELECT.
  const relation = await manager.query(`SELECT to_regclass('public.voucher_payment_links') AS rel`);
  if (relation?.[0]?.rel === null) return;
  let rows: { id: string }[];
  try {
    rows = await manager.query(`
      SELECT id FROM public.voucher_payment_links
      WHERE allocation_snapshot @> $1::jsonb LIMIT 1
    `, [JSON.stringify([{ invoiceId }])]);
  } catch (error) {
    const dbError = error as { driverError?: { code?: string }; code?: string };
    if ((dbError.driverError?.code ?? dbError.code) === '42P01') return;
    throw new ConflictException('Chưa kiểm chứng được nguồn hoàn tiền ưu đãi.');
  }
  if (!Array.isArray(rows) || rows.length > 0) {
    throw new ConflictException('Hóa đơn có ưu đãi cần quy trình hoàn tiền tương ứng.');
  }
}

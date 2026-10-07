import type { EntityManager } from 'typeorm';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { PartSource, PartWarrantyOption, WarrantyStatus } from '../../shared/enums';
import { recordOrderCompletedNotices } from '../notifications/order-completed-notice';

/**
 * What follows an order reaching COMPLETED, shared by the three paths that can
 * complete it (customer confirmation, confirmed cash, verified online payment):
 * warranty coverage starts for the eligible invoice lines and both parties are
 * notified. Runs inside the completing transaction.
 */
export async function applyOrderCompletionEffects(
  manager: EntityManager,
  order: { id: string; code: string; bookingId: string },
  invoiceId: string,
  now: Date,
): Promise<void> {
  const items = await manager.find(InvoiceItem, { where: { invoiceId } });
  let started = 0;
  for (const item of items) {
    if (
      item.warrantyDaysSnapshot <= 0 ||
      (item.partSource === PartSource.TECHNICIAN && item.partWarrantyOption !== PartWarrantyOption.PAID_WARRANTY)
    ) {
      continue;
    }
    await manager.insert(WarrantyCoverage, {
      serviceOrderId: order.id,
      invoiceItemId: item.id,
      warrantyDaysSnapshot: item.warrantyDaysSnapshot,
      startsAt: now,
      expiresAt: new Date(now.getTime() + item.warrantyDaysSnapshot * 86400000),
      status: WarrantyStatus.ACTIVE,
    });
    started++;
  }
  await recordOrderCompletedNotices(manager, order, started > 0);
}

import { In, type EntityManager } from 'typeorm';
import { WarrantyStatus } from '../../shared/enums';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';

/**
 * The status a coverage has right now. Coverages are stored active when the order completes and
 * nothing rewrites them, so an active coverage whose end date has passed reads as expired
 * (found 01/11/2026 in TC-WAR-003). Voided and other stored states are returned unchanged.
 * Read-only: a claim on an expired coverage is still taken and flagged submitted after expiry.
 */
export function effectiveWarrantyStatus(
  coverage: Pick<WarrantyCoverage, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): WarrantyStatus {
  if (coverage.status !== WarrantyStatus.ACTIVE) return coverage.status;
  return new Date(coverage.expiresAt).getTime() <= now.getTime() ? WarrantyStatus.EXPIRED : coverage.status;
}

/** Coverages as the API shows them: the effective status and the invoice line each one covers, read in one query. */
export async function presentCoverages(manager: EntityManager, coverages: WarrantyCoverage[], now: Date = new Date()) {
  const itemIds = coverages.map(c => c.invoiceItemId).filter((id): id is string => !!id);
  const items = itemIds.length ? await manager.findBy(InvoiceItem, { id: In(itemIds) }) : [];
  const byId = new Map(items.map(item => [item.id, item]));
  return coverages.map(coverage => {
    const item = coverage.invoiceItemId ? byId.get(coverage.invoiceItemId) : undefined;
    return { ...coverage, status: effectiveWarrantyStatus(coverage, now), itemType: item?.type ?? null, itemDescription: item?.description ?? null };
  });
}

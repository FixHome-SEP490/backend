import { WarrantyStatus } from '../../shared/enums';
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

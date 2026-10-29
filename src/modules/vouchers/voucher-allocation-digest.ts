import { createHash } from 'node:crypto';
import type { VoucherInvoiceFundingAllocation } from './voucher-funding-allocation';

/** jsonb does not retain object key order. Array order remains part of the proof. */
export function voucherAllocationDigest(snapshot: readonly VoucherInvoiceFundingAllocation[]): string {
  const json = JSON.stringify(snapshot, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
  return createHash('sha256').update(json).digest('hex');
}

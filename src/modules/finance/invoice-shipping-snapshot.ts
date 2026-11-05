import type { ShippingPolicyVersion } from './shipping-finance.policy';
import { calculateShippingShares } from './shipping-finance.policy';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';

export interface InvoiceShippingSnapshot {
  shippingPolicyVersion?: unknown;
  shippingFee?: unknown;
  customerShippingShare?: unknown;
  technicianShippingShare?: unknown;
}

/** Shipment inputs must come from a server-verified immutable source, never a client verdict.
 * This checks arithmetic only; it does not prove shipment identity, approval or completeness. */
export function readInvoiceShippingSnapshot(
  invoice: InvoiceShippingSnapshot,
  shipments?: readonly InvoiceShippingSnapshot[],
): {
  policyVersion: ShippingPolicyVersion;
  shippingFee: number;
  customerShippingShare: number;
  technicianShippingShare: number;
} {
  const invalid = (): never => {
    throw new BusinessException(
      ErrorCodes.CONFLICT,
      'Chi phí giao linh kiện không khớp dữ liệu đã chốt.',
    );
  };
  const amount = (value: unknown): number => {
    if (
      typeof value !== 'number' &&
      !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    )
      invalid();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
    return parsed;
  };
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice))
    invalid();
  // Undefined version is only the pre-migration object shape. SQL rows always have a version.
  const policyVersion =
    invoice.shippingPolicyVersion === undefined
      ? 'LEGACY_100_0'
      : invoice.shippingPolicyVersion;
  if (policyVersion !== 'LEGACY_100_0' && policyVersion !== 'W3_70_30_V1')
    invalid();
  const shippingFee = amount(
    invoice.shippingFee === undefined &&
      invoice.shippingPolicyVersion === undefined
      ? 0
      : invoice.shippingFee,
  );
  let shares = calculateShippingShares(
    shippingFee,
    policyVersion as ShippingPolicyVersion,
  );
  if (shipments !== undefined) {
    if (!Array.isArray(shipments) || shipments.length === 0) invalid();
    let total = 0n;
    let customer = 0n;
    let technician = 0n;
    for (const shipment of shipments) {
      if (!shipment || shipment.shippingFee === undefined) invalid();
      const snapshot = readInvoiceShippingSnapshot(shipment);
      if (snapshot.policyVersion !== policyVersion) invalid();
      total += BigInt(snapshot.shippingFee);
      customer += BigInt(snapshot.customerShippingShare);
      technician += BigInt(snapshot.technicianShippingShare);
    }
    // Per-shipment rounding is authoritative for arithmetic; do not split total S again.
    // Equality to a safe shippingFee bounds all nonnegative subtotals before conversion.
    if (total !== BigInt(shippingFee)) invalid();
    shares = {
      customerShippingShare: Number(customer),
      technicianShippingShare: Number(technician),
    };
  }
  const absent =
    invoice.customerShippingShare == null &&
    invoice.technicianShippingShare == null;
  if (absent) {
    if (policyVersion !== 'LEGACY_100_0') invalid();
  } else {
    if (
      invoice.shippingPolicyVersion === undefined ||
      amount(invoice.customerShippingShare) !== shares.customerShippingShare ||
      amount(invoice.technicianShippingShare) !== shares.technicianShippingShare
    )
      invalid();
  }
  return Object.freeze({
    policyVersion: policyVersion as ShippingPolicyVersion,
    shippingFee,
    ...shares,
  });
}

export function assertShippingFinancialCutoverAllowed(
  invoice: InvoiceShippingSnapshot,
): void {
  if (readInvoiceShippingSnapshot(invoice).policyVersion !== 'LEGACY_100_0') {
    // Deliberately no ENV/config override: unlocking needs a reviewed forward code + DB release.
    throw new BusinessException(
      ErrorCodes.CONFLICT,
      'Chính sách giao linh kiện chưa được mở thanh toán.',
    );
  }
}

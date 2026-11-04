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

export function readInvoiceShippingSnapshot(invoice: InvoiceShippingSnapshot): {
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
  const shares = calculateShippingShares(
    shippingFee,
    policyVersion as ShippingPolicyVersion,
  );
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

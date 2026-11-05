import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import {
  readInvoiceShippingSnapshot,
  type InvoiceShippingSnapshot,
} from './invoice-shipping-snapshot';

export interface InvoiceFinancialSnapshot extends InvoiceShippingSnapshot {
  laborTotal?: unknown;
  commissionAmount?: unknown;
  partsTotal?: unknown;
  fixHomePartsTotal?: unknown;
  technicianPartsTotal?: unknown;
  technicianPartWarrantyFeeTotal?: unknown;
  grandTotal?: unknown;
}

/** Frozen monetary facts BEFORE other labor deductions (D).
 * Not payout/funding authority: D's ledger, shipment source binding and cutover remain separate gates.
 * Legacy pre-migration shipping shape is read with the existing 100/0 compatibility rules. */
export function readInvoiceFinancialSnapshot(
  invoice: InvoiceFinancialSnapshot,
  shipments?: readonly InvoiceShippingSnapshot[],
) {
  const invalid = (): never => {
    throw new BusinessException(
      ErrorCodes.CONFLICT,
      'Dữ liệu tài chính không khớp hóa đơn đã chốt.',
    );
  };
  const vnd = (value: unknown): number => {
    if (
      typeof value !== 'number' &&
      !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    )
      invalid();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
    return parsed;
  };
  const checked = (value: bigint): number => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  };
  const shipping = readInvoiceShippingSnapshot(invoice, shipments);
  const laborTotal = vnd(invoice.laborTotal);
  const commissionAmount = vnd(invoice.commissionAmount);
  const partsTotal = vnd(invoice.partsTotal);
  const fixHomePartsTotal = vnd(invoice.fixHomePartsTotal);
  const technicianPartsTotal = vnd(invoice.technicianPartsTotal);
  const warrantyFeeTotal = vnd(invoice.technicianPartWarrantyFeeTotal);
  const grandTotal = vnd(invoice.grandTotal);
  if (
    BigInt(partsTotal) !==
      BigInt(fixHomePartsTotal) + BigInt(technicianPartsTotal) ||
    BigInt(grandTotal) !==
      BigInt(laborTotal) +
        BigInt(partsTotal) +
        BigInt(warrantyFeeTotal) +
        BigInt(shipping.customerShippingShare)
  )
    invalid();

  const platformDue = checked(
    BigInt(commissionAmount) +
      BigInt(fixHomePartsTotal) +
      BigInt(shipping.shippingFee),
  );
  const netLabor = checked(
    BigInt(laborTotal) -
      BigInt(commissionAmount) -
      BigInt(shipping.technicianShippingShare),
  );
  const nonlabor = checked(
    BigInt(technicianPartsTotal) + BigInt(warrantyFeeTotal),
  );
  const technicianPayout = checked(BigInt(grandTotal) - BigInt(platformDue));
  if (BigInt(technicianPayout) !== BigInt(netLabor) + BigInt(nonlabor))
    invalid();
  return Object.freeze({
    ...shipping,
    laborTotal,
    commissionAmount,
    partsTotal,
    fixHomePartsTotal,
    technicianPartsTotal,
    warrantyFeeTotal,
    grandTotal,
    platformDue,
    netLabor,
    nonlabor,
    technicianPayout,
  });
}

import { CostItemType } from '../../shared/enums/cost-item-type.enum';
import { PartSource } from '../../shared/enums/part-source.enum';
import { VoucherDiscount } from './voucher.types';
import type {
  VoucherFundedPriceResult,
  VoucherFundingInput,
  VoucherFundingInvoiceFacts,
  VoucherFundingInvoiceItemFacts,
  VoucherFundingReasonCode,
} from './voucher-funding.types';

const MAX_SAFE_VND = BigInt(Number.MAX_SAFE_INTEGER);

function isSafeNonnegativeVnd(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isValidCommissionRate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function safeAdd(left: number, right: number): number {
  const sum = BigInt(left) + BigInt(right);
  if (sum > MAX_SAFE_VND) {
    throw new RangeError('Voucher funding totals exceed the safe integer VND range.');
  }
  return Number(sum);
}

function isValidPolicy(input: VoucherFundingInput['policy']): boolean {
  if (!input || !Array.isArray(input.components)) return false;
  if (
    !input.components.includes('LABOR') ||
    !input.components.includes('PARTS') ||
    !isSafeNonnegativeVnd(input.value) ||
    input.value === 0 ||
    !isSafeNonnegativeVnd(input.minimumVnd)
  ) {
    return false;
  }

  if (input.capVnd !== null && !isSafeNonnegativeVnd(input.capVnd)) return false;
  if (input.capVnd === 0) return false;
  if (input.discount === VoucherDiscount.FIXED) return true;
  return input.discount === VoucherDiscount.PERCENT && input.value <= 100;
}

function isValidInvoice(invoice: VoucherFundingInvoiceFacts): boolean {
  return (
    !!invoice &&
    typeof invoice.invoiceId === 'string' &&
    invoice.invoiceId.trim().length > 0 &&
    invoice.successful === true &&
    isSafeNonnegativeVnd(invoice.originalGrossVnd) &&
    isSafeNonnegativeVnd(invoice.laborTotalVnd) &&
    isSafeNonnegativeVnd(invoice.fixHomePartsTotalVnd) &&
    isValidCommissionRate(invoice.commissionRateSnapshot) &&
    isSafeNonnegativeVnd(invoice.commissionAmountVnd) &&
    isSafeNonnegativeVnd(invoice.originalPlatformDueVnd) &&
    isSafeNonnegativeVnd(invoice.technicianEntitlementVnd) &&
    Array.isArray(invoice.items) &&
    BigInt(invoice.laborTotalVnd) + BigInt(invoice.fixHomePartsTotalVnd) <=
      BigInt(invoice.originalGrossVnd)
  );
}

function hasInvalidFixHomeParts(invoice: VoucherFundingInvoiceFacts): boolean {
  let sum = 0n;
  for (const candidate of invoice.items as readonly unknown[]) {
    if (!isRecord(candidate)) continue;
    if (candidate.invoiceId !== invoice.invoiceId) continue;
    if (candidate.type !== CostItemType.PARTS_EQUIPMENT ||
      candidate.partSource !== PartSource.FIXHOME) continue;
    const line = candidate as unknown as VoucherFundingInvoiceItemFacts;
    if (!isValidPartLine(line, invoice.invoiceId)) continue;
    sum += BigInt(line.lineTotalVnd);
  }
  return sum !== BigInt(invoice.fixHomePartsTotalVnd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidPartLine(
  line: VoucherFundingInvoiceItemFacts,
  invoiceId: string,
): line is VoucherFundingInvoiceItemFacts & {
  partSource: PartSource.FIXHOME;
  partCatalogId: string;
} {
  if (
    line.type !== CostItemType.PARTS_EQUIPMENT ||
    line.partSource !== PartSource.FIXHOME
  ) {
    return false;
  }

  if (
    line.invoiceId !== invoiceId ||
    typeof line.partCatalogId !== 'string' ||
    line.partCatalogId.trim().length === 0 ||
    !Number.isSafeInteger(line.quantity) ||
    line.quantity <= 0 ||
    !isSafeNonnegativeVnd(line.unitPriceVnd) ||
    !isSafeNonnegativeVnd(line.lineTotalVnd)
  ) {
    return false;
  }

  const expectedLineTotal = BigInt(line.quantity) * BigInt(line.unitPriceVnd);
  return (
    expectedLineTotal <= MAX_SAFE_VND &&
    Number(expectedLineTotal) === line.lineTotalVnd
  );
}

function eligibleFixHomePartsVnd(
  invoice: VoucherFundingInvoiceFacts,
  reasons: Set<VoucherFundingReasonCode>,
): number {
  let total = 0;
  for (const candidate of invoice.items as readonly unknown[]) {
    if (!isRecord(candidate)) {
      reasons.add('MALFORMED_LINE_EXCLUDED');
      continue;
    }

    if (candidate.invoiceId !== invoice.invoiceId) {
      reasons.add('FOREIGN_LINE_EXCLUDED');
      continue;
    }

    if (candidate.type !== CostItemType.PARTS_EQUIPMENT) continue;
    if (candidate.partSource !== PartSource.FIXHOME) {
      reasons.add('NON_FIXHOME_PART_EXCLUDED');
      continue;
    }

    const line = candidate as unknown as VoucherFundingInvoiceItemFacts;
    if (!isValidPartLine(line, invoice.invoiceId)) {
      reasons.add('MALFORMED_LINE_EXCLUDED');
      continue;
    }

    total = safeAdd(total, line.lineTotalVnd);
  }

  if (total > invoice.fixHomePartsTotalVnd) {
    reasons.add('INVALID_INVOICE_EXCLUDED');
    return 0;
  }
  return total;
}

function roundPercentToVnd(baseVnd: number, percent: number): number {
  const numerator = BigInt(baseVnd) * BigInt(percent);
  return Number((numerator + 50n) / 100n);
}

function boundedDiscountVnd(
  policy: VoucherFundingInput['policy'],
  eligibleBaseVnd: number,
  reasons: Set<VoucherFundingReasonCode>,
): number {
  if (eligibleBaseVnd === 0) {
    reasons.add('NO_ELIGIBLE_BASE');
    return 0;
  }
  if (eligibleBaseVnd < policy.minimumVnd) {
    reasons.add('MINIMUM_SPEND_NOT_MET');
    return 0;
  }

  const rawDiscount =
    policy.discount === VoucherDiscount.PERCENT
      ? roundPercentToVnd(eligibleBaseVnd, policy.value)
      : policy.value;
  const afterCampaignCap =
    policy.capVnd === null
      ? rawDiscount
      : Math.min(rawDiscount, policy.capVnd);
  const discount = Math.min(afterCampaignCap, eligibleBaseVnd);

  if (afterCampaignCap < rawDiscount) reasons.add('CAP_APPLIED');
  if (discount < afterCampaignCap) reasons.add('CAP_APPLIED');
  if (discount === 0) {
    reasons.add('DISCOUNT_ROUNDED_TO_ZERO');
    return 0;
  }
  reasons.add('DISCOUNT_APPLIED');
  return discount;
}

/**
 * Deterministically calculates a FixHome-funded voucher preview from verified frozen server
 * facts. It does not create a quote, reserve a claim, mutate an invoice, or settle a payment.
 */
export function calculateVoucherFundedPrice(
  input: VoucherFundingInput,
): VoucherFundedPriceResult {
  if (!input || !Array.isArray(input.invoices)) {
    throw new TypeError('Voucher funding requires a verified invoice list.');
  }
  const reasons = new Set<VoucherFundingReasonCode>();
  const acceptedInvoices: VoucherFundingInvoiceFacts[] = [];
  const seenInvoiceIds = new Set<string>();

  for (const candidate of input.invoices as readonly unknown[]) {
    if (!isRecord(candidate)) {
      reasons.add('INVALID_INVOICE_EXCLUDED');
      continue;
    }
    if (candidate.successful === false) {
      reasons.add('FAILED_CHILD_EXCLUDED');
      continue;
    }
    if (!isValidInvoice(candidate as unknown as VoucherFundingInvoiceFacts) ||
      hasInvalidFixHomeParts(candidate as unknown as VoucherFundingInvoiceFacts)) {
      reasons.add('INVALID_INVOICE_EXCLUDED');
      continue;
    }
    const invoice = candidate as unknown as VoucherFundingInvoiceFacts;
    if (seenInvoiceIds.has(invoice.invoiceId)) {
      reasons.add('DUPLICATE_INVOICE_EXCLUDED');
      continue;
    }
    seenInvoiceIds.add(invoice.invoiceId);
    acceptedInvoices.push(invoice);
  }

  let originalGrossVnd = 0;
  let eligibleBaseVnd = 0;
  let originalCommissionAmountVnd = 0;
  let originalPlatformDueVnd = 0;
  let technicianEntitlementVnd = 0;
  const invoiceSnapshots = [] as Array<{
    invoiceId: string;
    originalGrossVnd: number;
    commissionRateSnapshot: number;
    commissionAmountVnd: number;
    originalPlatformDueVnd: number;
    technicianEntitlementVnd: number;
  }>;

  for (const invoice of acceptedInvoices) {
    const partsVnd = eligibleFixHomePartsVnd(invoice, reasons);
    originalGrossVnd = safeAdd(originalGrossVnd, invoice.originalGrossVnd);
    originalCommissionAmountVnd = safeAdd(
      originalCommissionAmountVnd,
      invoice.commissionAmountVnd,
    );
    originalPlatformDueVnd = safeAdd(
      originalPlatformDueVnd,
      invoice.originalPlatformDueVnd,
    );
    technicianEntitlementVnd = safeAdd(
      technicianEntitlementVnd,
      invoice.technicianEntitlementVnd,
    );
    eligibleBaseVnd = safeAdd(
      eligibleBaseVnd,
      safeAdd(invoice.laborTotalVnd, partsVnd),
    );
    invoiceSnapshots.push({
      invoiceId: invoice.invoiceId,
      originalGrossVnd: invoice.originalGrossVnd,
      commissionRateSnapshot: invoice.commissionRateSnapshot,
      commissionAmountVnd: invoice.commissionAmountVnd,
      originalPlatformDueVnd: invoice.originalPlatformDueVnd,
      technicianEntitlementVnd: invoice.technicianEntitlementVnd,
    });
  }

  const validPolicy = isValidPolicy(input.policy);
  if (!validPolicy) reasons.add('INVALID_POLICY');
  const fixHomeDiscountSubsidyVnd = validPolicy
    ? boundedDiscountVnd(input.policy, eligibleBaseVnd, reasons)
    : 0;

  return Object.freeze({
    originalGrossVnd,
    eligibleBaseVnd,
    fixHomeDiscountSubsidyVnd,
    customerDueVnd: originalGrossVnd - fixHomeDiscountSubsidyVnd,
    originalCommissionAmountVnd,
    originalPlatformDueVnd,
    technicianEntitlementVnd,
    invoiceSnapshots: Object.freeze(
      invoiceSnapshots.map((snapshot) => Object.freeze(snapshot)),
    ),
    reasonCodes: Object.freeze([...reasons]),
  });
}

import { calculateVoucherFundedPrice } from './voucher-funded-price';
import type {
  VoucherFundedPriceResult,
  VoucherFundingInput,
  VoucherFundingInvoiceSnapshot,
} from './voucher-funding.types';

const MAX_SAFE_VND = BigInt(Number.MAX_SAFE_INTEGER);

export interface VoucherInvoiceFundingAllocation extends VoucherFundingInvoiceSnapshot {
  readonly eligibleBaseVnd: number;
  readonly subsidyVnd: number;
  readonly customerDueVnd: number;
}

export interface VoucherFundingAllocation {
  readonly total: VoucherFundedPriceResult;
  /** Stable invoice-id order; persist these values before initiating any payment. */
  readonly invoices: readonly VoucherInvoiceFundingAllocation[];
}

function vnd(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Invalid voucher funding amount.');
  }
  return BigInt(value);
}

/**
 * Splits a verified scope discount by each invoice's eligible frozen base. Largest
 * remainders receive the remaining dong, with invoice id as the stable tie break.
 * The result is a persistence input, never authority to collect discounted money.
 */
export function allocateVoucherFunding(input: VoucherFundingInput): VoucherFundingAllocation {
  const total = calculateVoucherFundedPrice(input);
  const successful = input.invoices.filter(invoice => invoice.successful === true);
  if (successful.length === 0 || total.invoiceSnapshots.length !== successful.length ||
      total.fixHomeDiscountSubsidyVnd <= 0 || total.reasonCodes.some(code =>
        ['INVALID_POLICY', 'INVALID_INVOICE_EXCLUDED', 'DUPLICATE_INVOICE_EXCLUDED',
          'FOREIGN_LINE_EXCLUDED', 'MALFORMED_LINE_EXCLUDED'].includes(code))) {
    throw new RangeError('Voucher funding source is incomplete or inconsistent.');
  }
  const sourceById = new Map(successful.map(invoice => [invoice.invoiceId, invoice]));
  const base = vnd(total.eligibleBaseVnd);
  const discount = vnd(total.fixHomeDiscountSubsidyVnd);
  if (base === 0n || discount > base) {
    throw new RangeError('Voucher funding exceeds the eligible base.');
  }
  const shares = total.invoiceSnapshots.map(snapshot => {
    const source = sourceById.get(snapshot.invoiceId);
    if (!source) throw new RangeError('Voucher invoice snapshot is missing.');
    const eligible = vnd(source.laborTotalVnd) + vnd(source.fixHomePartsTotalVnd);
    if (eligible > MAX_SAFE_VND || eligible > vnd(snapshot.originalGrossVnd)) {
      throw new RangeError('Voucher invoice eligible base is invalid.');
    }
    const numerator = discount * eligible;
    return { snapshot, eligible, subsidy: numerator / base, remainder: numerator % base };
  });
  const allocated = shares.reduce((sum, share) => sum + share.subsidy, 0n);
  const remainderCount = Number(discount - allocated);
  if (remainderCount < 0 || remainderCount > shares.length) {
    throw new RangeError('Voucher allocation remainder is invalid.');
  }
  shares.sort((a, b) => a.remainder === b.remainder
    ? a.snapshot.invoiceId.localeCompare(b.snapshot.invoiceId)
    : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < remainderCount; index++) shares[index].subsidy += 1n;
  const invoices = shares
    .sort((a, b) => a.snapshot.invoiceId.localeCompare(b.snapshot.invoiceId))
    .map(({ snapshot, eligible, subsidy }) => {
      if (subsidy > eligible) throw new RangeError('Voucher invoice subsidy exceeds eligibility.');
      return Object.freeze({
        ...snapshot,
        eligibleBaseVnd: Number(eligible),
        subsidyVnd: Number(subsidy),
        customerDueVnd: snapshot.originalGrossVnd - Number(subsidy),
      });
    });
  return Object.freeze({ total, invoices: Object.freeze(invoices) });
}

export interface VoucherRefundDelta {
  readonly originalGrossRefundVnd: number;
  readonly customerRefundVnd: number;
  readonly subsidyReversalVnd: number;
}

/**
 * Cumulative gross refund amounts must come from a verified, persisted refund event.
 * Delta-from-target rounding makes retries and split refunds add to the original
 * per-invoice allocation without a second whole-voucher redemption.
 */
export function calculateVoucherRefundDelta(
  allocation: VoucherInvoiceFundingAllocation,
  priorGrossRefundedVnd: number,
  nextGrossRefundedVnd: number,
): VoucherRefundDelta {
  const gross = vnd(allocation.originalGrossVnd);
  const subsidy = vnd(allocation.subsidyVnd);
  const prior = vnd(priorGrossRefundedVnd);
  const next = vnd(nextGrossRefundedVnd);
  if (gross === 0n || subsidy > gross || next < prior || next > gross ||
      allocation.customerDueVnd !== allocation.originalGrossVnd - allocation.subsidyVnd) {
    throw new RangeError('Voucher refund is inconsistent with frozen funding.');
  }
  const reversedAt = (refunded: bigint) => (subsidy * refunded * 2n + gross) / (2n * gross);
  const subsidyReversal = reversedAt(next) - reversedAt(prior);
  const grossDelta = next - prior;
  return Object.freeze({
    originalGrossRefundVnd: Number(grossDelta),
    customerRefundVnd: Number(grossDelta - subsidyReversal),
    subsidyReversalVnd: Number(subsidyReversal),
  });
}

/**
 * NET is the existing SupportCase.amount contract. Rounding can make several
 * gross refund targets produce the same NET; reject those instead of guessing
 * how much company subsidy to reverse. A separately verified gross source is
 * required for ambiguous partial refunds and every zero-due refund.
 */
export function resolveVoucherRefundFromCustomerNet(
  allocation: VoucherInvoiceFundingAllocation,
  priorGrossRefundedVnd: number,
  customerNetRefundVnd: number,
): VoucherRefundDelta {
  const gross = vnd(allocation.originalGrossVnd);
  const prior = vnd(priorGrossRefundedVnd);
  const net = vnd(customerNetRefundVnd);
  if (net === 0n || prior >= gross) {
    throw new RangeError('A verified gross refund source is required.');
  }
  const priorCustomer = BigInt(calculateVoucherRefundDelta(
    allocation, 0, Number(prior),
  ).customerRefundVnd);
  const target = priorCustomer + net;
  if (target > vnd(allocation.customerDueVnd)) {
    throw new RangeError('Customer refund exceeds frozen customer due.');
  }
  const customerAt = (refunded: bigint): bigint => BigInt(calculateVoucherRefundDelta(
    allocation, 0, Number(refunded),
  ).customerRefundVnd);
  let low = prior + 1n;
  let high = gross;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (customerAt(mid) < target) low = mid + 1n;
    else high = mid;
  }
  if (customerAt(low) !== target ||
      (low < gross && customerAt(low + 1n) === target)) {
    throw new RangeError('Customer NET does not identify one gross refund.');
  }
  return calculateVoucherRefundDelta(allocation, Number(prior), Number(low));
}

/**
 * For an ambiguous NET amount, the gross delta must be a separately persisted,
 * manager-approved source fact. This pure check does not make caller input
 * authoritative; the database adapter must verify its origin and ownership.
 */
export function validateVoucherRefundGrossForNet(
  allocation: VoucherInvoiceFundingAllocation,
  priorGrossRefundedVnd: number,
  customerNetRefundVnd: number,
  verifiedGrossRefundVnd: number,
): VoucherRefundDelta {
  const prior = vnd(priorGrossRefundedVnd);
  const net = vnd(customerNetRefundVnd);
  const grossDelta = vnd(verifiedGrossRefundVnd);
  if (grossDelta === 0n || prior + grossDelta > vnd(allocation.originalGrossVnd)) {
    throw new RangeError('Verified gross refund is outside the frozen invoice.');
  }
  const delta = calculateVoucherRefundDelta(allocation, Number(prior), Number(prior + grossDelta));
  if (BigInt(delta.customerRefundVnd) !== net) {
    throw new RangeError('Approved NET does not match verified gross refund.');
  }
  return delta;
}

/** Pure full-scope signal; a DB transaction still has to verify and restore quota. */
export function canRestoreVoucherAfterRefund(
  invoices: readonly VoucherInvoiceFundingAllocation[],
  grossRefundedByInvoice: Readonly<Record<string, number>>,
): boolean {
  if (invoices.length === 0 || Object.keys(grossRefundedByInvoice).length !== invoices.length) return false;
  return invoices.every(invoice =>
    grossRefundedByInvoice[invoice.invoiceId] === invoice.originalGrossVnd);
}

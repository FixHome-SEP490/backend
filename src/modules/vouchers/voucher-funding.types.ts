import type { CostItemType } from '../../shared/enums/cost-item-type.enum';
import type { PartSource } from '../../shared/enums/part-source.enum';
import type { VoucherPolicy } from './voucher.types';

/**
 * Server-only policy input. The caller must build this from persisted frozen invoice and
 * settlement facts; never map amounts from a request DTO into this contract. The source
 * adapter is intentionally pending in this policy-only lane.
 */
export interface VoucherFundingInput {
  readonly policy: VoucherPolicy;
  readonly invoices: readonly VoucherFundingInvoiceFacts[];
}

/** Immutable original-money facts for one repair child in the checkout scope. */
export interface VoucherFundingInvoiceFacts {
  readonly invoiceId: string;
  /** Derived by the server from the persisted repair outcome; failed children are excluded. */
  readonly successful: boolean;
  /** Frozen Invoice.grandTotal, including non-eligible fees and historical part sources. */
  readonly originalGrossVnd: number;
  /** Frozen Invoice.laborTotal. */
  readonly laborTotalVnd: number;
  /** Frozen Invoice.fixHomePartsTotal; used to bound resolved catalogue line facts. */
  readonly fixHomePartsTotalVnd: number;
  /** Frozen Invoice commission rate; carried through without recalculation. */
  readonly commissionRateSnapshot: number;
  /** Frozen Invoice.commissionAmount. */
  readonly commissionAmountVnd: number;
  /** Original T1 PlatformDue snapshot for this invoice. */
  readonly originalPlatformDueVnd: number;
  /** Original T1 technician entitlement snapshot for this invoice. */
  readonly technicianEntitlementVnd: number;
  /** Frozen invoice lines. Their quantity is the final billed quantity from actual USED facts. */
  readonly items: readonly VoucherFundingInvoiceItemFacts[];
}

/**
 * Frozen InvoiceItem fields plus the server-resolved catalogue id. InvoiceItem.sourceItemId
 * must be joined to its approved source row by a future server adapter; this field is not a
 * client assertion and that adapter is not implemented in this lane.
 */
export interface VoucherFundingInvoiceItemFacts {
  readonly invoiceId: string;
  readonly type: CostItemType;
  readonly partSource?: PartSource | null;
  readonly partCatalogId?: string | null;
  /** Frozen InvoiceItem.quantity; existing invoice creation bills actual USED quantity. */
  readonly quantity: number;
  readonly unitPriceVnd: number;
  readonly lineTotalVnd: number;
}

export interface VoucherFundingInvoiceSnapshot {
  readonly invoiceId: string;
  readonly originalGrossVnd: number;
  readonly commissionRateSnapshot: number;
  readonly commissionAmountVnd: number;
  readonly originalPlatformDueVnd: number;
  readonly technicianEntitlementVnd: number;
}

export type VoucherFundingReasonCode =
  | 'DISCOUNT_APPLIED'
  | 'CAP_APPLIED'
  | 'DISCOUNT_ROUNDED_TO_ZERO'
  | 'NO_ELIGIBLE_BASE'
  | 'MINIMUM_SPEND_NOT_MET'
  | 'INVALID_POLICY'
  | 'INVALID_INVOICE_EXCLUDED'
  | 'FAILED_CHILD_EXCLUDED'
  | 'DUPLICATE_INVOICE_EXCLUDED'
  | 'FOREIGN_LINE_EXCLUDED'
  | 'MALFORMED_LINE_EXCLUDED'
  | 'NON_FIXHOME_PART_EXCLUDED';

/** Money result for a preview only; no payment, invoice or settlement state is mutated. */
export interface VoucherFundedPriceResult {
  /** ORIGINAL_GROSS: sum of frozen successful invoice grand totals. */
  readonly originalGrossVnd: number;
  /** ELIGIBLE_BASE: frozen original labor plus actual-used FixHome catalogue parts. */
  readonly eligibleBaseVnd: number;
  /** FIXHOME_DISCOUNT_SUBSIDY: the full customer discount funded by FixHome. */
  readonly fixHomeDiscountSubsidyVnd: number;
  /** CUSTOMER_DUE: ORIGINAL_GROSS less the FixHome-funded subsidy. */
  readonly customerDueVnd: number;
  /** Original commission amount snapshots, summed without recalculation. */
  readonly originalCommissionAmountVnd: number;
  /** Original PlatformDue snapshots, summed without voucher adjustment. */
  readonly originalPlatformDueVnd: number;
  /** Original technician entitlement snapshots, summed without voucher adjustment. */
  readonly technicianEntitlementVnd: number;
  /** Per-invoice immutable money snapshots retained for downstream allocation. */
  readonly invoiceSnapshots: readonly VoucherFundingInvoiceSnapshot[];
  readonly reasonCodes: readonly VoucherFundingReasonCode[];
}

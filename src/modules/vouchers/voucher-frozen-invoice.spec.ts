import { describe, expect, it } from 'vitest';
import { CostItemType, PartSource, PaymentStatus } from '../../shared/enums';
import type { Invoice } from '../service-orders/entities/invoice.entity';
import type { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { frozenVoucherInvoiceFacts, type VoucherApprovedPartSource } from './voucher-frozen-invoice';

const baseInvoice = {
  id: 'invoice-1', serviceOrderId: 'order-1', laborTotal: 200_000, partsTotal: 500_000,
  fixHomePartsTotal: 300_000, technicianPartsTotal: 200_000,
  technicianPartWarrantyFeeTotal: 0, shippingFee: 0, grandTotal: 700_000,
  commissionRateSnapshot: 0.1, commissionAmount: 20_000,
  paymentStatus: PaymentStatus.UNPAID,
} as Invoice;
const usedFixHome = {
  id: 'line-1', invoiceId: 'invoice-1', sourceType: 'QUOTATION', sourceItemId: 'source-1',
  type: CostItemType.PARTS_EQUIPMENT, partSource: PartSource.FIXHOME,
  quantity: 1, unitPrice: 300_000, lineTotal: 300_000,
} as InvoiceItem;
const techPart = {
  id: 'line-2', invoiceId: 'invoice-1', sourceType: 'QUOTATION', sourceItemId: 'source-2',
  type: CostItemType.PARTS_EQUIPMENT, partSource: PartSource.TECHNICIAN,
  quantity: 1, unitPrice: 200_000, lineTotal: 200_000,
} as InvoiceItem;
const laborLine = { id: 'line-3', invoiceId: 'invoice-1', sourceType: 'FIXED_PRICE',
  type: CostItemType.LABOR, quantity: 1, unitPrice: 200_000, lineTotal: 200_000 } as InvoiceItem;
const approved = new Map<string, VoucherApprovedPartSource>([['QUOTATION:source-1', {
  id: 'source-1', partCatalogId: 'catalog-1', partSource: PartSource.FIXHOME,
  type: CostItemType.PARTS_EQUIPMENT, unitPrice: 300_000, quantity: 2,
  serviceOrderId: 'order-1', approved: true,
}]]);

describe('frozenVoucherInvoiceFacts', () => {
  it('uses the billed USED quantity and excludes historical technician stock', () => {
    const facts = frozenVoucherInvoiceFacts(baseInvoice, [usedFixHome, techPart, laborLine], approved);
    expect(facts).toMatchObject({
      originalGrossVnd: 700_000, laborTotalVnd: 200_000,
      fixHomePartsTotalVnd: 300_000, commissionAmountVnd: 20_000,
      originalPlatformDueVnd: 320_000, technicianEntitlementVnd: 380_000,
    });
    expect(facts.items[0]).toMatchObject({ partCatalogId: 'catalog-1', quantity: 1 });
    expect(facts.items[1]).toMatchObject({ partSource: PartSource.TECHNICIAN });
  });

  it('rejects a FixHome line without its approved catalogue source', () => {
    expect(() => frozenVoucherInvoiceFacts(baseInvoice, [usedFixHome, techPart, laborLine], new Map())).toThrow();
  });

  it('rejects a foreign or unapproved part source even when price and catalogue match', () => {
    const source = approved.get('QUOTATION:source-1')!;
    expect(() => frozenVoucherInvoiceFacts({ ...baseInvoice, serviceOrderId: 'order-1' } as Invoice,
      [usedFixHome, techPart, laborLine], new Map([['QUOTATION:source-1', { ...source, serviceOrderId: 'other-order' }]]))).toThrow();
    expect(() => frozenVoucherInvoiceFacts({ ...baseInvoice, serviceOrderId: 'order-1' } as Invoice,
      [usedFixHome, techPart, laborLine], new Map([['QUOTATION:source-1', { ...source, approved: false }]]))).toThrow();
    expect(() => frozenVoucherInvoiceFacts(baseInvoice,
      [usedFixHome, techPart, laborLine],
      new Map([['QUOTATION:source-1', { ...source, partSource: PartSource.TECHNICIAN }]]))).toThrow();
  });

  it('rejects a labor subtotal inconsistent with frozen invoice lines', () => {
    expect(() => frozenVoucherInvoiceFacts(baseInvoice, [usedFixHome, techPart], approved)).toThrow();
  });

  it('rejects a changed original commission or gross snapshot', () => {
    expect(() => frozenVoucherInvoiceFacts({ ...baseInvoice, commissionAmount: 10_000 } as Invoice,
      [usedFixHome, techPart, laborLine], approved)).toThrow();
  });
});

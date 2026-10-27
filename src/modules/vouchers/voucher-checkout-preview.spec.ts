import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import { CostItemType, PartSource, PaymentStatus, QuotationStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { Service } from '../services/entities/service.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { loadVoucherPreviewInvoices } from './voucher-checkout-preview';

const order = { id: 'order-1', bookingId: 'booking-1', completionRequestedAt: new Date() };
const booking = { id: 'booking-1', customerId: 'customer-1', serviceId: 'service-1', visitGroupId: null };
const service = { id: 'service-1', categoryId: 'category-1' };
const invoice = { id: 'invoice-1', serviceOrderId: 'order-1', paymentStatus: PaymentStatus.UNPAID,
  laborTotal: 200_000, partsTotal: 300_000, fixHomePartsTotal: 300_000, technicianPartsTotal: 0,
  technicianPartWarrantyFeeTotal: 0, shippingFee: 0, grandTotal: 500_000,
  commissionRateSnapshot: 0.1, commissionAmount: 20_000 };
const item = { id: 'line-1', invoiceId: 'invoice-1', sourceType: 'QUOTATION', sourceItemId: 'source-1',
  type: CostItemType.PARTS_EQUIPMENT, partSource: PartSource.FIXHOME,
  quantity: 1, unitPrice: 300_000, lineTotal: 300_000 };
const laborItem = { id: 'line-labor', invoiceId: 'invoice-1', sourceType: 'FIXED_PRICE',
  type: CostItemType.LABOR, quantity: 1, unitPrice: 200_000, lineTotal: 200_000 };
const approved = { id: 'source-1', quotationId: 'quote-1', type: CostItemType.PARTS_EQUIPMENT, partSource: PartSource.FIXHOME,
  partCatalogId: 'catalog-1', quantity: 2, unitPrice: 300_000 };

function soloManager(owner = 'customer-1', paymentStatus = PaymentStatus.UNPAID): EntityManager {
  return {
    findOneBy: async (entity: unknown, where: { id?: string }) => {
      if (entity === VisitGroup) return null;
      if (entity === ServiceOrder) return where.id === order.id ? order : null;
      if (entity === Booking) return { ...booking, customerId: owner };
      if (entity === Invoice) return { ...invoice, paymentStatus };
      if (entity === Service) return service;
      return null;
    },
    findBy: async (entity: unknown) => {
      if (entity === InvoiceItem) return [item, laborItem];
      if (entity === QuotationItem) return [approved];
      if (entity === Quotation) return [{ id: 'quote-1', serviceOrderId: 'order-1', status: QuotationStatus.APPROVED }];
      if (entity === AdditionalCostItem) return [];
      return [];
    },
  } as unknown as EntityManager;
}

describe('loadVoucherPreviewInvoices', () => {
  it('reads original solo invoice and its approved FIXHOME catalogue source', async () => {
    const facts = await loadVoucherPreviewInvoices(soloManager(), 'customer-1', 'order-1');
    expect(facts.services).toEqual([{ serviceId: 'service-1', categoryId: 'category-1' }]);
    expect(facts.invoices[0]).toMatchObject({
      originalGrossVnd: 500_000, fixHomePartsTotalVnd: 300_000,
      technicianEntitlementVnd: 180_000,
    });
    expect(facts.invoices[0].items[0]).toMatchObject({ partCatalogId: 'catalog-1', quantity: 1 });
  });

  it('denies another customer before reading any invoice lines', async () => {
    await expect(loadVoucherPreviewInvoices(soloManager('other-customer'), 'customer-1', 'order-1'))
      .rejects.toThrow();
  });

  it('rejects an already paid invoice rather than exposing a stale discount', async () => {
    await expect(loadVoucherPreviewInvoices(soloManager('customer-1', PaymentStatus.PAID), 'customer-1', 'order-1'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('prices only successful A and C when B failed in a three-device visit', async () => {
    const group = { id: 'group-1', customerId: 'customer-1' };
    const groupItems = ['A', 'B', 'C'].map((name, index) => ({
      groupId: group.id, bookingId: `booking-${name}`, sequence: index + 1,
      outcome: name === 'B' ? 'failed' : 'succeeded',
    }));
    const bookings = ['A', 'B', 'C'].map(name => ({
      id: `booking-${name}`, customerId: 'customer-1', visitGroupId: group.id,
      serviceId: `service-${name}`, status: 'matched',
    }));
    const orders = ['A', 'B', 'C'].map(name => ({
      id: `order-${name}`, bookingId: `booking-${name}`,
      completionRequestedAt: name === 'B' ? null : new Date(), status: 'under_repair',
    }));
    const invoices = ['A', 'C'].map(name => ({ ...invoice,
      id: `invoice-${name}`, serviceOrderId: `order-${name}`,
      laborTotal: 200_000, partsTotal: 0, fixHomePartsTotal: 0,
      commissionAmount: 20_000, grandTotal: 200_000,
    }));
    const manager = {
      findOneBy: async (entity: unknown, where: { id?: string }) => {
        if (entity === VisitGroup) return group;
        if (entity === ServiceOrder) return orders.find(row => row.id === where.id);
        if (entity === Invoice) return invoices.find(row => row.id === where.id);
        if (entity === Booking) return bookings.find(row => row.id === where.id);
        if (entity === Service) return { id: where.id, categoryId: 'category-1' };
        return null;
      },
      find: async (entity: unknown) => entity === VisitGroupItem ? groupItems : entity === Invoice ? invoices : [],
      findBy: async (entity: unknown, where: { invoiceId?: string }) => entity === Booking ? bookings : entity === ServiceOrder ? orders :
        entity === InvoiceItem ? [{ ...laborItem, invoiceId: where.invoiceId }] : [],
    } as unknown as EntityManager;
    const facts = await loadVoucherPreviewInvoices(manager, 'customer-1', group.id);
    expect(facts.invoices.map(row => row.invoiceId)).toEqual(['invoice-A', 'invoice-C']);
    expect(facts.invoices.reduce((sum, row) => sum + row.originalGrossVnd, 0)).toBe(400_000);
  });
});

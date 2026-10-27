import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AdditionalCostStatus, PaymentStatus, QuotationStatus, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { loadVisitCharge } from '../finance/visit-charge';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { Service } from '../services/entities/service.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { frozenVoucherInvoiceFacts, VoucherApprovedPartSource } from './voucher-frozen-invoice';
import type { VoucherFundingInvoiceFacts } from './voucher-funding.types';

/** Read-only scope proof. Its result is a preview, never a reservation or payment authority. */
export async function loadVoucherPreviewInvoices(
  manager: EntityManager, customerId: string, scopeId: string, lock = false,
): Promise<{ invoices: VoucherFundingInvoiceFacts[]; services: { serviceId: string; categoryId: string }[] }> {
  const denied = () => { throw new ForbiddenException('Không tìm thấy lượt thanh toán phù hợp.'); };
  const group = await manager.findOneBy(VisitGroup, { id: scopeId });
  let allocations: { invoiceId: string; serviceOrderId: string; amount: number }[];
  if (group) {
    if (group.customerId !== customerId) denied();
    const charge = await loadVisitCharge(manager, scopeId, lock);
    if (!charge.ready || charge.waiting !== 0 || charge.total <= 0) {
      throw new ConflictException('Lượt sửa chưa sẵn sàng thanh toán.');
    }
    allocations = charge.allocations;
  } else {
    const order = await manager.findOneBy(ServiceOrder, { id: scopeId });
    if (!order) denied();
    const booking = await manager.findOneBy(Booking, { id: order.bookingId });
    if (!booking || booking.customerId !== customerId || booking.visitGroupId) denied();
    const invoice = lock
      ? await manager.findOne(Invoice, { where: { serviceOrderId: order.id }, lock: { mode: 'pessimistic_write' } })
      : await manager.findOneBy(Invoice, { serviceOrderId: order.id });
    if (!invoice || !order.completionRequestedAt || order.status === ServiceOrderStatus.CANCELLED ||
        invoice.paymentStatus !== PaymentStatus.UNPAID ||
        Number(invoice.grandTotal) <= 0) {
      throw new ConflictException('Hóa đơn chưa sẵn sàng thanh toán.');
    }
    allocations = [{ invoiceId: invoice.id, serviceOrderId: order.id, amount: Number(invoice.grandTotal) }];
  }

  const invoices: VoucherFundingInvoiceFacts[] = [];
  const services: { serviceId: string; categoryId: string }[] = [];
  for (const allocation of allocations) {
    const order = await manager.findOneBy(ServiceOrder, { id: allocation.serviceOrderId });
    const invoice = await manager.findOneBy(Invoice, { id: allocation.invoiceId });
    const booking = order && await manager.findOneBy(Booking, { id: order.bookingId });
    const service = booking && await manager.findOneBy(Service, { id: booking.serviceId });
    if (!order || !invoice || !booking || !service || booking.customerId !== customerId ||
        (group ? booking.visitGroupId !== group.id : !!booking.visitGroupId) ||
        invoice.serviceOrderId !== order.id || !order.completionRequestedAt || order.status === ServiceOrderStatus.CANCELLED ||
        invoice.paymentStatus !== PaymentStatus.UNPAID || Number(invoice.grandTotal) !== allocation.amount) {
      throw new ConflictException('Dữ liệu thanh toán đã thay đổi.');
    }
    const items = await manager.findBy(InvoiceItem, { invoiceId: invoice.id });
    const quotationIds = items.filter(i => i.sourceType === 'QUOTATION' && i.sourceItemId).map(i => i.sourceItemId!);
    const additionalIds = items.filter(i => i.sourceType === 'ADDITIONAL' && i.sourceItemId).map(i => i.sourceItemId!);
    const [quotation, additional] = await Promise.all([
      quotationIds.length ? manager.findBy(QuotationItem, { id: In(quotationIds) }) : Promise.resolve([]),
      additionalIds.length ? manager.findBy(AdditionalCostItem, { id: In(additionalIds) }) : Promise.resolve([]),
    ]);
    const quotationParents = quotation.length ? await manager.findBy(Quotation, { id: In(quotation.map(i => i.quotationId)) }) : [];
    const additionalParents = additional.length ? await manager.findBy(AdditionalCostRequest, { id: In(additional.map(i => i.requestId)) }) : [];
    const quoteById = new Map(quotationParents.map(parent => [parent.id, parent]));
    const additionalById = new Map(additionalParents.map(parent => [parent.id, parent]));
    const approved = new Map<string, VoucherApprovedPartSource>();
    for (const source of quotation) {
      const parent = quoteById.get(source.quotationId);
      approved.set(`QUOTATION:${source.id}`, { ...source, serviceOrderId: parent?.serviceOrderId ?? '', approved: parent?.status === QuotationStatus.APPROVED });
    }
    for (const source of additional) {
      const parent = additionalById.get(source.requestId);
      approved.set(`ADDITIONAL:${source.id}`, { ...source, serviceOrderId: parent?.serviceOrderId ?? '', approved: parent?.status === AdditionalCostStatus.APPROVED });
    }
    invoices.push(frozenVoucherInvoiceFacts(invoice, items, approved));
    services.push({ serviceId: service.id, categoryId: service.categoryId });
  }
  return { invoices, services };
}

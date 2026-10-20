import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from './finance.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { RepairEvidence } from '../service-orders/entities/repair-evidence.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { Payment } from './entities/payment.entity';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CostItemType, PaymentMode, Role } from '../../shared/enums';

const customer = { id: 'customer', role: Role.CUSTOMER };

function setup(amount = 0) {
  const invoice: any = { id: 'invoice', serviceOrderId: 'order', grandTotal: amount, laborTotal: amount,
    partsTotal: 0, fixHomePartsTotal: 0, technicianPartsTotal: 0, technicianPartWarrantyFeeTotal: 0, shippingFee: 0,
    commissionBase: 'LABOR', commissionRateSnapshot: 0.1, commissionAmount: Math.round(amount * 0.1), paymentStatus: 'unpaid' };
  const order: any = { id: 'order', code: 'TEST-ORDER', bookingId: 'booking', status: 'under_repair', paymentStatus: 'unpaid', completionRequestedAt: new Date() };
  const booking: any = { id: 'booking', customerId: 'customer', pricingModeSnapshot: 'inspection_required' };
  const quote: any = { id: 'quote', status: 'approved', laborTotal: amount, partsTotal: 0,
    items: [{ id: 'qi', type: CostItemType.LABOR, quantity: 1, unitPrice: amount, lineTotal: amount }] };
  const requests: any[] = [];
  const audits: any[] = [];
  const writes: any[] = [];
  const payments: any[] = [];
  const cash: any[] = [];
  let held = false;
  const repository = (entity: any) => ({
    findOne: async () => entity === Invoice ? invoice : entity === ServiceOrder ? order : null,
    save: async (value: any) => { writes.push({ entity, value: structuredClone(value) }); return value; },
    update: async (_where: any, value: any) => { writes.push({ entity, value }); if (entity === ServiceOrder) Object.assign(order, value); },
    create: (value: any) => value,
  });
  const manager: any = {
    findOne: vi.fn(async (entity, options) => {
      if (entity === Invoice) return invoice;
      if (entity === ServiceOrder) return order;
      if (entity === Booking) return booking;
      if (entity === Quotation) return quote;
      if (entity === AuditLog) return audits.find(a => a.action === options.where.action) ?? null;
      if (entity === TechnicianAssignment) return { technicianId: 'tech' };
      return null;
    }),
    findOneBy: async (entity: any) => entity === TechnicianAssignment ? { technicianId: 'tech' } : entity === Booking ? booking : null,
    findOneOrFail: async (entity: any, options: any) => manager.findOne(entity, options),
    find: async (entity: any) => entity === PartRequest ? requests : entity === InvoiceItem ? [{ type: 'labor', quantity: 1, unitPrice: amount, lineTotal: amount, warrantyDaysSnapshot: 0 }] : [],
    count: vi.fn(async entity => entity === RepairEvidence ? 1 : entity === SupportCase && held ? 1 : 0),
    query: async () => [{ held }],
    getRepository: (entity: any) => entity === Payment ? {
      create: (value: any) => value, findOne: async () => null,
      save: async (value: any) => { payments.push(value); return { ...value, id: 'payment' }; },
    } : entity === CashSettlement ? {
      findOne: async () => null, create: (value: any) => value,
      save: async (value: any) => { const saved = { ...value, id: 'cash' }; cash.push(saved); return saved; },
    } : repository(entity),
    create: (_entity: any, value: any) => value,
    save: async (entity: any, value: any) => entity === Payment ? manager.getRepository(Payment).save(value) : repository(entity).save(value),
    update: async (entity: any, where: any, value: any) => repository(entity).update(where, value),
    insert: async (entity: any, value: any) => { writes.push({ entity, value }); },
  };
  const service: any = Object.create(FinanceService.prototype);
  Object.assign(service, {
    dataSource: { manager, transaction: async (run: any) => run(manager) },
    configService: { getInt: async (_key: string, fallback: number) => fallback, getString: async () => PaymentMode.LIVE },
    config: { get: (key: string) => ({ VNPAY_TMN_CODE: 'TEST', VNPAY_HASH_SECRET: 'test-only', VNPAY_PAYMENT_URL: 'https://example.test/pay', VNPAY_RETURN_URL: 'https://example.test/return' })[key] },
    auditLogService: { logWithManager: async (_manager: any, event: any) => { audits.push(event); } },
    customerWalletService: { apply: vi.fn(async () => ({ id: 'wallet-tx', balanceAfter: 1 })) },
    paymentVerificationPort: { verify: vi.fn() },
    settlementService: { trySettleOrder: vi.fn() },
  });
  return { service, invoice, order, booking, quote, requests, audits, writes, payments, cash, manager, hold: () => { held = true; } };
}

describe('P013 genuine free invoice confirmation', () => {
  it('B06 customer confirms genuine zero once, without a payment provider or wallet entry', async () => {
    const s = setup();
    const result = await s.service.confirmNoChargeInvoice('invoice', customer);
    expect(result).toEqual({ invoiceId: 'invoice', paymentStatus: 'paid', settlementMethod: 'NO_CHARGE' });
    expect(s.order.status).toBe('completed');
    const writeCount = s.writes.length;
    expect(await s.service.confirmNoChargeInvoice('invoice', customer)).toEqual(result);
    expect(s.writes).toHaveLength(writeCount);
    expect(s.invoice.paymentStatus).toBe('paid');
    expect(s.order.paymentStatus).toBe('paid');
    expect(s.audits.filter(a => a.action === 'INVOICE_NO_CHARGE_CONFIRMED')).toHaveLength(1);
    expect(s.payments).toHaveLength(0);
    expect(s.service.customerWalletService.apply).not.toHaveBeenCalled();
    expect(s.service.paymentVerificationPort.verify).not.toHaveBeenCalled();
    expect(s.service.settlementService.trySettleOrder).not.toHaveBeenCalled();
    expect(s.manager.findOne).toHaveBeenCalledWith(ServiceOrder, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
  });

  it('B06 preserves a completion hold after free confirmation', async () => {
    const s = setup(); s.hold();
    await s.service.confirmNoChargeInvoice('invoice', customer);
    expect(s.invoice.paymentStatus).toBe('paid');
    expect(s.order.status).toBe('under_repair');
  });

  it('rejects positive invoices before locking the order to avoid competing with positive payment lock paths', async () => {
    const s = setup(5000);
    await expect(s.service.confirmNoChargeInvoice('invoice', customer)).rejects.toThrow();
    expect(s.manager.findOne).not.toHaveBeenCalledWith(ServiceOrder, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    expect(s.writes).toHaveLength(0);
  });

  it('B06 rejects the misleading zero snapshot with approved positive FixHome parts without rewriting it', async () => {
    const s = setup();
    s.quote.laborTotal = 0; s.quote.partsTotal = 550000;
    s.quote.items = [{ id: 'part-line', type: 'parts_equipment', partSource: 'fixhome', partCatalogId: 'sku', quantity: 1, unitPrice: 550000, lineTotal: 550000 }];
    await expect(s.service.confirmNoChargeInvoice('invoice', customer)).rejects.toThrow();
    expect(s.invoice.paymentStatus).toBe('unpaid');
    expect(s.writes).toHaveLength(0); expect(s.payments).toHaveLength(0);
  });

  it('B06 allows a positive approved part excluded by a matching received RETURNED record', async () => {
    const s = setup(); s.quote.partsTotal = 100;
    s.quote.items.push({ id: 'part-line', type: 'parts_equipment', partSource: 'fixhome', partCatalogId: 'sku', quantity: 1, unitPrice: 100, lineTotal: 100 });
    s.requests.push({ requestType: 'quotation', quotationId: 'quote', status: 'received', receivedAt: new Date(), technicianId: 'tech',
      items: [{ id: 'part', partSource: 'fixhome', partCatalogId: 'sku', quantity: 1, usageStatus: 'returned' }] });
    await s.service.confirmNoChargeInvoice('invoice', customer);
    expect(s.invoice.paymentStatus).toBe('paid');
  });

  it.each(['labor', 'technician', 'used-fixhome', 'after-evidence', 'pending-approval'])('B06 refuses zero confirmation for %s inconsistency', async scenario => {
    const s = setup();
    if (scenario === 'labor') {
      s.quote.laborTotal = 100; s.quote.items[0].unitPrice = 100; s.quote.items[0].lineTotal = 100;
    }
    if (scenario === 'technician' || scenario === 'used-fixhome') {
      const fixhome = scenario === 'used-fixhome';
      s.quote.partsTotal = 100;
      s.quote.items.push({ id: 'part-line', type: 'parts_equipment', partSource: fixhome ? 'fixhome' : 'technician',
        partCatalogId: fixhome ? 'sku' : null, quantity: 1, unitPrice: 100, lineTotal: 100 });
      if (fixhome) s.requests.push({ requestType: 'quotation', quotationId: 'quote', status: 'received', technicianId: 'tech',
        items: [{ partSource: 'fixhome', partCatalogId: 'sku', quantity: 1, usageStatus: 'used' }] });
    }
    if (scenario === 'after-evidence') s.manager.count.mockImplementation(async () => 0);
    if (scenario === 'pending-approval') s.manager.count.mockImplementation(async entity => entity === Quotation || entity === RepairEvidence ? 1 : 0);
    await expect(s.service.confirmNoChargeInvoice('invoice', customer)).rejects.toThrow();
    expect(s.writes).toHaveLength(0); expect(s.audits).toHaveLength(0);
  });

  it.each(['technician', 'service_manager', 'admin'])('B06 denies %s even for a free invoice', async role => {
    const s = setup();
    await expect(s.service.confirmNoChargeInvoice('invoice', { id: 'customer', role })).rejects.toThrow();
    expect(s.writes).toHaveLength(0);
  });

  it.each(['other-customer', 'cancelled', 'not-complete', 'paid-historical', 'positive', 'negative', 'pending-parts'])('B06 rejects %s without a mutation', async scenario => {
    const s = setup();
    if (scenario === 'cancelled') s.order.status = 'cancelled';
    if (scenario === 'not-complete') s.order.completionRequestedAt = null;
    if (scenario === 'paid-historical') s.invoice.paymentStatus = 'paid';
    if (scenario === 'positive') s.invoice.grandTotal = 1;
    if (scenario === 'negative') s.invoice.grandTotal = -1;
    if (scenario === 'pending-parts') s.requests.push({ technicianId: 'tech', status: 'requested', items: [] });
    await expect(s.service.confirmNoChargeInvoice('invoice', { ...customer, id: scenario === 'other-customer' ? 'outsider' : customer.id })).rejects.toThrow();
    expect(s.writes).toHaveLength(0);
  });
});

describe('P013 invoice payment channel boundaries', () => {
  it.each([0, 1, 4999, -1])('B07 blocks VNPay amount %i before creating a payment', async amount => {
    const s = setup(amount);
    await expect(s.service.createVnpayPaymentUrl('invoice', customer, '127.0.0.1')).rejects.toThrow();
    expect(s.payments).toHaveLength(0);
  });

  it('B07 allows VNPay at 5000', async () => {
    const s = setup(5000);
    expect((await s.service.createVnpayPaymentUrl('invoice', customer, '127.0.0.1')).paymentUrl).toContain('vnp_Amount=500000');
    expect(s.payments[0].amount).toBe(5000);
  });

  it.each([1, 4999])('B07 allows customer wallet amount %i', async amount => {
    const s = setup(amount);
    const result = await s.service.payInvoiceWithWallet('invoice', customer);
    expect(result.amount).toBe(amount);
    expect(s.payments[0]).toMatchObject({ amount, provider: 'wallet' });
    await expect(s.service.payInvoiceWithWallet('invoice', customer)).rejects.toThrow();
    expect(s.service.customerWalletService.apply).toHaveBeenCalledTimes(1);
  });

  it.each([1, 4999])('B07 allows exact CASH declaration at %i', async amount => {
    const s = setup(amount);
    const result = await s.service.declareCashSettlement('order', { declaredAmount: amount }, { id: 'tech', role: Role.TECHNICIAN });
    expect(result).toMatchObject({ status: 'pending_confirmation', declaredAmount: amount });
    expect(s.cash).toHaveLength(1);
    expect(s.invoice.paymentStatus).toBe('unpaid');
  });

  it('B07 keeps wallet top-up minimum at 10000 independently from invoice minimum', async () => {
    const s = setup();
    await expect(s.service.createWalletTopUpVnpayUrl('customer', 9999, '127.0.0.1')).rejects.toThrow();
    expect(s.payments).toHaveLength(0);
    expect((await s.service.createWalletTopUpVnpayUrl('customer', 10000, '127.0.0.1')).paymentUrl).toContain('vnp_Amount=1000000');
    expect(s.payments[0].amount).toBe(10000);
  });
});

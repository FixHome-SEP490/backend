import { describe, expect, it, vi } from 'vitest';
import { QuotationsService } from './quotations.service';
import { Quotation } from './entities/quotation.entity';
import { QuotationItem } from './entities/quotation-item.entity';
import { PartRequestsService } from '../part-requests/part-requests.service';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { PartRequestItem } from '../part-requests/entities/part-request-item.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { InvoiceItem } from '../service-orders/entities/invoice-item.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { PartUsageStatus, Role } from '../../shared/enums';
import { createPartCustodySnapshot } from '../part-requests/part-custody.rules';

function setup(preRepair: any[] = []) {
  const order = { id: 'order', bookingId: 'booking', status: 'en_route' };
  const quote = { id: 'quote', serviceOrderId: 'order', technicianId: 'tech', status: 'sent', laborTotal: 0, partsTotal: 600,
    items: [1, 2].map(quantity => ({ id: `qi${quantity}`, quotationId: 'quote', type: 'parts_equipment', partSource: 'fixhome', partCatalogId: 'sku', description: 'Approved name', quantity, unitPrice: 200 })) };
  const requests: any[] = [...preRepair];
  const audits: any[] = [];
  const invoiceLines: any[] = [];
  const cost: any = { id: 'cost', serviceOrderId: 'order', technicianId: 'tech', status: 'pending_approval', totalLaborDelta: 0,
    totalPartsDelta: 200, expiresAt: new Date(Date.now() + 600000), items: [{ id: 'aci', type: 'parts_equipment', partSource: 'fixhome', partCatalogId: 'sku', description: 'Extra', quantity: 1, unitPrice: 200 }] };
  const manager: any = {
    findOne: vi.fn(async (entity, options) => {
      if (entity === ServiceOrder) return order;
      if (entity === Booking) return { id: 'booking', pricingModeSnapshot: 'inspection_required' };
      if (entity === Quotation) return Object.entries(options.where).every(([key, value]) => quote[key] === value) ? quote : null;
      if (entity === FixHomePart) return { id: options.where.id, name: 'Catalog part', isActive: true, sellingPrice: 900 };
      if (entity === PartRequest) return requests.find(r => options.where.id ? r.id === options.where.id : r.quotationId === options.where.quotationId) ?? null;
      if (entity === PartRequestItem) return requests.flatMap(r => r.items).find(i => i.id === options.where.id) ?? null;
      return null;
    }),
    findOneBy: vi.fn(async (entity) => entity === Booking ? { customerId: 'customer' }
      : entity === TechnicianAssignment ? { technicianId: 'tech', isActive: true }
      : entity === ArrivalCheckIn ? { result: 'valid' } : null),
    findOneByOrFail: vi.fn(async () => ({ id: 'booking', pricingModeSnapshot: 'inspection_required' })),
    count: vi.fn(async () => 0),
    findOneOrFail: vi.fn(async (entity, options) => entity === Quotation ? quote : entity === AdditionalCostRequest ? cost : manager.findOne(entity, options)),
    find: vi.fn(async (entity, options) => entity === PartRequest ? requests : entity === PartRequestItem ? requests.find(r => r.id === options.where.partRequestId)?.items ?? [] : []),
    create: (_entity: any, value: any) => ({ ...value }),
    save: vi.fn(async (entity, value) => {
      if (entity === Quotation) value.id ??= 'quote';
      if (entity === PartRequest) { value.id ??= `pr${requests.length}`; if (!requests.includes(value)) requests.push(value); }
      if (entity === PartRequestItem && Array.isArray(value)) value.forEach((item: any, i: number) => { item.id ??= `item${i}`; });
      return value ?? entity;
    }),
    update: vi.fn(), insert: vi.fn(async (entity, value) => { if (entity === InvoiceItem) invoiceLines.push(value); }),
  };
  const dataSource: any = { transaction: (run: any) => run(manager) };
  const audit: any = { logWithManager: async (_manager: any, event: any) => { audits.push(event); } };
  const parts = new PartRequestsService(dataSource, {} as any, {} as any, {} as any, audit, { createNotification: async () => undefined } as any);
  const service = new QuotationsService({ findOneBy: async () => quote } as any, {} as any, { findOneBy: async () => cost } as any, {} as any,
    {} as any, {} as any, {} as any, dataSource, {} as any, audit, parts);
  return { service, parts, manager, quote, requests, audits, order, cost, invoiceLines };
}

describe('P013 approval creates only missing depot supply', () => {
  function preRepair(quantities: number[], status = 'received', sku = 'sku') {
    return { id: 'pre', serviceOrderId: 'order', technicianId: 'tech', requestType: 'pre_repair', status,
      items: quantities.map((quantity, index) => ({ id: `pre-item${index}`, partSource: 'fixhome', partCatalogId: sku,
        quantity, usageStatus: 'pending' })) };
  }

  it.each(['requested', 'ready', 'delivering', 'received'])('rejects creating a quote for 2 when a whole pre-repair line of 3 is %s', async status => {
    const s = setup([preRepair([3], status)]);
    const items = [{ ...s.quote.items[0], quantity: 2 }];
    await expect(s.service.createQuotation('order', { items: items as any }, { id: 'tech', role: Role.TECHNICIAN }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('số lượng') });
    expect(s.manager.save).not.toHaveBeenCalled();
    expect(s.manager.update).not.toHaveBeenCalled();
  });

  it('rechecks whole-line quantities on APPROVE if supply changed after quoting', async () => {
    const prior = preRepair([2]);
    const s = setup([prior]);
    const created = await s.service.createQuotation('order', { items: [{ ...s.quote.items[0], quantity: 2 }] as any }, { id: 'tech', role: Role.TECHNICIAN });
    Object.assign(s.quote, created, { id: 'quote' });
    prior.items[0].quantity = 3;
    s.manager.save.mockClear(); s.manager.update.mockClear();
    await expect(s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER }))
      .rejects.toMatchObject({ status: 409 });
    expect(s.quote.status).toBe('sent');
    expect(s.manager.save).not.toHaveBeenCalled();
    expect(s.manager.update).not.toHaveBeenCalled();
  });

  it('allows 1-to-1 whole-line reuse and requests an extra quote SKU', async () => {
    const s = setup([preRepair([1])]);
    const items = [{ ...s.quote.items[0], quantity: 1 }, { ...s.quote.items[1], partCatalogId: 'extra-sku', quantity: 2 }];
    const created = await s.service.createQuotation('order', { items: items as any }, { id: 'tech', role: Role.TECHNICIAN });
    Object.assign(s.quote, created, { id: 'quote' });
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1].items).toMatchObject([{ partCatalogId: 'extra-sku', quantity: 2 }]);
  });

  it('allows a subset of whole lines while remaining lines can be returned', async () => {
    const s = setup([preRepair([3, 2])]);
    s.quote.items = [{ ...s.quote.items[0], quantity: 2 }];
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    expect(s.quote.status).toBe('approved');
    expect(s.requests).toHaveLength(1);
  });

  it.each([[3, 3], [2, 3]])('rejects nonrepresentable duplicate-SKU lines %j without reusing a line twice', async (...quantities) => {
    const s = setup([preRepair(quantities)]);
    s.quote.items = [{ ...s.quote.items[0], quantity: 2 }, { ...s.quote.items[1], quantity: 2 }];
    await expect(s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER }))
      .rejects.toMatchObject({ status: 409 });
    expect(s.quote.status).toBe('sent');
  });

  it.each([Role.TECHNICIAN, Role.SERVICE_MANAGER])('blocks %s from cancelling linked QUOTATION supply after approval', async role => {
    const s = setup();
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    const request = s.requests[0];
    s.manager.save.mockClear();
    await expect(s.parts.cancelPartRequest(request.id, { id: role === Role.TECHNICIAN ? 'tech' : 'manager', role }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('báo giá') });
    expect(request.status).toBe('requested');
    expect(s.manager.save).not.toHaveBeenCalled();
  });

  it.each([Role.TECHNICIAN, Role.SERVICE_MANAGER])('blocks %s from cancelling PRE_REPAIR supply reused by the approved quote', async role => {
    const s = setup([preRepair([2], 'requested')]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    await expect(s.parts.cancelPartRequest('pre', { id: role === Role.TECHNICIAN ? 'tech' : 'manager', role }))
      .rejects.toMatchObject({ status: 409 });
    expect(s.requests[0].status).toBe('requested');
    expect(s.requests[1].items[0].quantity).toBe(1);
  });

  it.each(['ready', 'delivering'])('blocks manager cancellation of necessary %s supply and preserves its QR token', async status => {
    const s = setup([preRepair([2], status)]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    for (const request of s.requests) {
      request.status = status; request.qrToken = 'handover-token';
      await expect(s.parts.cancelPartRequest(request.id, { id: 'manager', role: Role.SERVICE_MANAGER })).rejects.toMatchObject({ status: 409 });
      expect(request).toMatchObject({ status, qrToken: 'handover-token' });
    }
  });

  it('allows cancelling unrelated PRE_REPAIR stock after a base quote is approved', async () => {
    const s = setup([preRepair([3], 'requested', 'other-sku')]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    expect(await s.parts.cancelPartRequest('pre', { id: 'tech', role: Role.TECHNICIAN })).toMatchObject({ status: 'cancelled' });
    expect(s.requests[1].status).toBe('requested');
  });

  it('allows cancelling unreceived PRE_REPAIR before quoting so exact QUOTATION supply can be issued', async () => {
    const s = setup([preRepair([3], 'requested')]);
    await s.parts.cancelPartRequest('pre', { id: 'tech', role: Role.TECHNICIAN });
    const created = await s.service.createQuotation('order', { items: [{ ...s.quote.items[0], quantity: 2 }] as any }, { id: 'tech', role: Role.TECHNICIAN });
    Object.assign(s.quote, created, { id: 'quote' });
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    expect(s.requests[1].items).toMatchObject([{ partCatalogId: 'sku', quantity: 2 }]);
  });

  it('preserves cancellation of ADDITIONAL requests independently of approved base supply', async () => {
    const s = setup();
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    s.order.status = 'under_repair';
    await s.service.decideAdditionalCost('cost', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    expect(await s.parts.cancelPartRequest(s.requests[1].id, { id: 'tech', role: Role.TECHNICIAN })).toMatchObject({ status: 'cancelled' });
    expect(s.requests[0].status).toBe('requested');
  });

  it.each(['sent', 'rejected', 'superseded'])('does not protect supply on behalf of a %s quote', async status => {
    const s = setup([preRepair([3], 'requested')]); s.quote.status = status;
    expect(await s.parts.cancelPartRequest('pre', { id: 'tech', role: Role.TECHNICIAN })).toMatchObject({ status: 'cancelled' });
  });

  it('does not protect a QUOTATION request linked to a different quote', async () => {
    const s = setup();
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: Role.CUSTOMER });
    s.requests[0].quotationId = 'old-quote';
    expect(await s.parts.cancelPartRequest(s.requests[0].id, { id: 'tech', role: Role.TECHNICIAN })).toMatchObject({ status: 'cancelled' });
  });

  it('B01 creates a linked request with approved snapshots, groups duplicate SKU lines, and replays without mutation', async () => {
    const s = setup();
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ requestType: 'quotation', quotationId: 'quote', serviceOrderId: 'order', technicianId: 'tech', shippingFee: 0,
      status: 'requested', items: [{ partCatalogId: 'sku', quantity: 3, unitPriceSnapshot: 200, partNameSnapshot: 'Approved name', usageStatus: 'pending' }] });
    const frozen = JSON.stringify(s.quote);
    const auditCount = s.audits.length;
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests).toHaveLength(1);
    expect(JSON.stringify(s.quote)).toBe(frozen);
    expect(s.audits).toHaveLength(auditCount);
    expect(s.manager.findOne).toHaveBeenCalledWith(ServiceOrder, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
  });

  it('B01 requires real QR receipt then approved USED before invoicing the same duplicate SKU quote exactly once', async () => {
    const s = setup();
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    const request = s.requests[0];
    const tech = { id: 'tech', role: Role.TECHNICIAN };
    const orders: any = Object.create(ServiceOrdersService.prototype);
    orders.configService = { getInt: async () => 1000 };
    await expect(orders.generateInvoice('order', s.manager)).rejects.toThrow();
    const ready = await s.parts.markReady(request.id, { id: 'manager', role: Role.SERVICE_MANAGER });
    await expect(s.parts.receiveByQr(request.id, { qrToken: 'wrong' }, tech)).rejects.toThrow();
    await s.parts.receiveByQr(request.id, { qrToken: ready.qrToken! }, tech);
    await expect(s.parts.updateItemUsage(request.id, request.items[0].id, { usageStatus: PartUsageStatus.USED }, tech)).rejects.toThrow();
    s.order.status = 'under_repair';
    await s.parts.updateItemUsage(request.id, request.items[0].id, { usageStatus: PartUsageStatus.USED }, tech);
    const invoice = await orders.generateInvoice('order', s.manager);
    expect(invoice).toMatchObject({ fixHomePartsTotal: 600, grandTotal: 600, commissionAmount: 0 });
    expect(s.invoiceLines.map(i => i.quantity)).toEqual([1, 2]);
    expect(s.invoiceLines.map(i => i.unitPrice)).toEqual([200, 200]);
    expect(s.manager.save.mock.calls.filter(([entity]: any) => entity === Invoice)).toHaveLength(1);
  });

  it('B03 additional approval creates its own ADDITIONAL request and repeated APPROVE does not issue twice', async () => {
    const s = setup();
    s.order.status = 'under_repair';
    await s.service.decideAdditionalCost('cost', 'APPROVE', { id: 'customer', role: 'customer' });
    await s.service.decideAdditionalCost('cost', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ requestType: 'additional', additionalCostId: 'cost', items: [{ partCatalogId: 'sku', quantity: 1 }] });
    expect(s.requests[0].quotationId).toBeUndefined();
  });

  it('B01 mixed approved technician parts remain chargeable and commission applies only to labor', async () => {
    const s = setup();
    s.quote.laborTotal = 1000; s.quote.partsTotal = 900;
    s.quote.items.push({ id: 'labor', quotationId: 'quote', type: 'labor', partSource: null, partCatalogId: null,
      description: 'Labor', quantity: 1, unitPrice: 1000 });
    s.quote.items.push({ id: 'tech-part', quotationId: 'quote', type: 'parts_equipment', partSource: 'technician', partCatalogId: null,
      description: 'Technician part', quantity: 1, unitPrice: 300 });
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    const request = s.requests[0];
    expect(request.items).toHaveLength(1);
    const ready = await s.parts.markReady(request.id, { id: 'manager', role: Role.SERVICE_MANAGER });
    await s.parts.receiveByQr(request.id, { qrToken: ready.qrToken! }, { id: 'tech', role: Role.TECHNICIAN });
    s.order.status = 'under_repair';
    await s.parts.updateItemUsage(request.id, request.items[0].id, { usageStatus: PartUsageStatus.USED }, { id: 'tech', role: Role.TECHNICIAN });
    const orders: any = Object.create(ServiceOrdersService.prototype);
    orders.configService = { getInt: async () => 1000 };
    expect(await orders.generateInvoice('order', s.manager)).toMatchObject({ laborTotal: 1000, fixHomePartsTotal: 600,
      technicianPartsTotal: 300, partsTotal: 900, grandTotal: 1900, commissionAmount: 100, commissionBase: 'LABOR' });
  });

  it('B01 splits a large grouped deficit into depot lines compatible with the existing custody quantity limit', async () => {
    const s = setup();
    s.quote.items[0].quantity = 101; s.quote.items[1].quantity = 100;
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests[0].items.map(i => i.quantity)).toEqual([100, 100, 1]);
    for (const item of s.requests[0].items) {
      expect(() => createPartCustodySnapshot({ serviceOrderId: 'order', partRequestId: s.requests[0].id, partRequestItemId: item.id,
        requestType: s.requests[0].requestType, quotationId: 'quote', additionalCostId: null, partCatalogId: 'sku', source: item.partSource,
        originalCustodianTechnicianId: 'tech', issuedQty: item.quantity, usedQty: 0, serviceOrderStatus: 'under_repair' as any, invoiceFrozen: false })).not.toThrow();
    }
  });

  it.each(['requested', 'ready', 'delivering', 'received'])('B02 preserves active pre-repair %s stock and requests only the deficit', async status => {
    const prior = { id: 'pre', serviceOrderId: 'order', technicianId: 'tech', requestType: 'pre_repair', status,
      items: [{ partSource: 'fixhome', partCatalogId: 'sku', quantity: 2, usageStatus: 'pending' }] };
    const frozen = JSON.stringify(prior);
    const s = setup([prior]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1].items[0].quantity).toBe(1);
    expect(JSON.stringify(prior)).toBe(frozen);
  });

  it('B02 creates no second request when existing current technician supply covers the quote', async () => {
    const s = setup([{ technicianId: 'tech', requestType: 'pre_repair', status: 'received',
      items: [{ partSource: 'fixhome', partCatalogId: 'sku', quantity: 3, usageStatus: 'pending' }] }]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests).toHaveLength(1);
  });

  it.each([
    { technicianId: 'old-tech', status: 'received', usageStatus: 'pending' },
    { technicianId: 'tech', status: 'cancelled', usageStatus: 'pending' },
    { technicianId: 'tech', status: 'received', usageStatus: 'returned' },
  ])('B02 does not reuse outgoing/cancelled/returned stock: %j', async prior => {
    const s = setup([{ ...prior, requestType: 'pre_repair', items: [{ partSource: 'fixhome', partCatalogId: 'sku', quantity: 3, usageStatus: prior.usageStatus }] }]);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' });
    expect(s.requests[1].items[0].quantity).toBe(3);
  });

  it('B04 repeated rejection creates no warehouse supply', async () => {
    const s = setup();
    await s.service.decideQuotation('quote', 'REJECT', { id: 'customer', role: 'customer' });
    await s.service.decideQuotation('quote', 'REJECT', { id: 'customer', role: 'customer' });
    expect(s.quote.status).toBe('rejected');
    expect(s.requests).toHaveLength(0);
    expect(s.manager.save.mock.calls.some(([entity]: any) => entity === QuotationItem)).toBe(false);
  });

  it('B04 historical APPROVED replay never backfills stock or changes the approved snapshot', async () => {
    const s = setup(); s.quote.status = 'approved';
    s.order.status = 'under_repair';
    const frozen = JSON.stringify(s.quote);
    await s.service.decideQuotation('quote', 'APPROVE', { id: 'customer', role: 'customer' }, ['different-warranty']);
    expect(JSON.stringify(s.quote)).toBe(frozen);
    expect(s.requests).toHaveLength(0);
    expect(s.audits).toHaveLength(0);
    expect(s.manager.save).not.toHaveBeenCalled();
  });
});

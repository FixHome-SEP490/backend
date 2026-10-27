import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrder } from './entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';
import { assertPartsResolved, usedPartQuantities } from '../part-requests/part-request-lifecycle';
import { EvidenceType, PartRequestStatus, PartRequestType, PartSource, PartUsageStatus, Role, ServiceOrderStatus, ServicePricingMode } from '../../shared/enums';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';

describe('Parts reconciliation at invoice freeze', () => {
  it('preserves every existing invoice snapshot without recalculation, including historical paid and invalid unpaid zero', async () => {
    for (const paymentStatus of ['paid', 'unpaid']) {
      const existing = { id: 'invoice', serviceOrderId: 'order', paymentStatus, grandTotal: 0 };
      const manager = { findOneBy: vi.fn().mockResolvedValue(existing), save: vi.fn(), insert: vi.fn() };
      const service = Object.create(ServiceOrdersService.prototype);
      expect(await service.generateInvoice('order', manager)).toBe(existing);
      expect(manager.findOneBy).toHaveBeenCalledWith(Invoice, { serviceOrderId: 'order' });
      expect(manager.save).not.toHaveBeenCalled(); expect(manager.insert).not.toHaveBeenCalled();
    }
  });
  it('bills exactly 2 of 3 issued for an enrolled item while preserving legacy quantity and approvals', () => {
    const requests = [{ id: 'request', status: PartRequestStatus.RECEIVED, requestType: PartRequestType.PRE_REPAIR,
      items: [{ id: 'item', quantity: 3, partSource: PartSource.FIXHOME, partCatalogId: 'part', usageStatus: PartUsageStatus.USED }] }] as PartRequest[];
    const bill = usedPartQuantities(requests, new Map([['item', 2]]));
    expect(bill('quotation', { partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 3 })).toBe(2);
    expect(bill('quotation', { partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 3 })).toBe(0);
    expect(requests[0].items[0].quantity).toBe(3);
    expect(usedPartQuantities(requests)('quotation', { partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 3 })).toBe(3);
  });
  it('invoices approved USED quantities only, excluding RETURNED and non-received parts', async () => {
    const approved = (id: string, catalog: string, quantity = 1) => ({ id, type: 'parts_equipment', partSource: 'fixhome', partCatalogId: catalog, quantity, unitPrice: 100, lineTotal: quantity * 100 });
    const requests = [
      { requestType: 'pre_repair', status: 'received', items: [
        { partSource: 'fixhome', partCatalogId: 'used', quantity: 2, usageStatus: 'used' },
        { partSource: 'fixhome', partCatalogId: 'returned', quantity: 1, usageStatus: 'returned' },
      ] },
      { requestType: 'additional', additionalCostId: 'cost', fulfillmentMethod: 'delivery', receivedAt: new Date(), status: 'received', items: [
        { partSource: 'fixhome', partCatalogId: 'extra', quantity: 1, usageStatus: 'used' },
      ] },
    ];
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(null),
      findOne: vi.fn(async entity => entity === ServiceOrder ? { bookingId: 'booking' } : entity === Booking ? { pricingModeSnapshot: 'inspection_required' } : entity === Quotation ? { id: 'quote', items: [approved('q1', 'used', 1), approved('q2', 'used', 1), approved('q3', 'returned')] } : null),
      find: vi.fn(async entity => entity === PartRequest ? requests : entity === AdditionalCostRequest ? [{ id: 'cost', shippingFee: 25 }] : []),
      createQueryBuilder: vi.fn(() => ({ where: () => ({ getMany: async () => [{ ...approved('a1', 'extra'), requestId: 'cost' }] }) })),
      create: vi.fn((_entity, value) => value),
      save: vi.fn(async (_entity, value) => ({ ...value, id: 'invoice' })),
      insert: vi.fn(), update: vi.fn(),
    };
    const service = Object.create(ServiceOrdersService.prototype);
    service.configService = { getInt: vi.fn().mockResolvedValue(1000) };
    const invoice = await service.generateInvoice('order', manager);
    expect(invoice).toMatchObject({ partsTotal: 300, fixHomePartsTotal: 300, shippingFee: 25, grandTotal: 325, commissionAmount: 0 });
    const lines = manager.insert.mock.calls.filter(([entity]) => entity === InvoiceItem).map(([, item]) => item);
    expect(lines.map(item => item.sourceItemId)).toEqual(['q1', 'q2', 'a1']);
    expect(lines.map(item => item.quantity)).toEqual([1, 1, 1]);
  });

  it('B01 pools linked quotation supply with pre-repair and never leaks it into additional costs', () => {
    const requests = [{ requestType: 'quotation', quotationId: 'quote', status: 'received',
      items: [{ partSource: 'fixhome', partCatalogId: 'part', quantity: 2, usageStatus: 'used' }] }] as PartRequest[];
    const bill = usedPartQuantities(requests);
    const item = { partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 1 };
    expect(bill('cost', item)).toBe(0);
    expect(bill('quotation', item)).toBe(1);
    expect(bill('quotation', item)).toBe(1);
    expect(bill('quotation', item)).toBe(0);
  });

  it('B05 rejects an approved positive part with no supply before inserting an invoice', async () => {
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(null),
      findOne: vi.fn(async entity => entity === ServiceOrder ? { bookingId: 'booking' } : entity === Booking
        ? { pricingModeSnapshot: 'inspection_required' } : entity === Quotation
          ? { id: 'quote', items: [{ id: 'qi', type: 'parts_equipment', partSource: 'fixhome', partCatalogId: 'part', quantity: 1, unitPrice: 550000 }] } : null),
      find: vi.fn().mockResolvedValue([]),
      create: vi.fn((_entity, value) => value), save: vi.fn(async (_entity, value) => value),
      insert: vi.fn(), update: vi.fn(),
    };
    const service = Object.create(ServiceOrdersService.prototype);
    service.configService = { getInt: vi.fn().mockResolvedValue(1000) };
    await expect(service.generateInvoice('order', manager)).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('blocks pending usage and does not consume another additional approval or cancelled request', () => {
    const request = { status: PartRequestStatus.RECEIVED, requestType: PartRequestType.ADDITIONAL, additionalCostId: 'cost1', items: [{ partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 2, usageStatus: PartUsageStatus.PENDING }] } as PartRequest;
    expect(() => assertPartsResolved([request])).toThrow('USED/RETURNED');
    request.items[0].usageStatus = PartUsageStatus.USED;
    const consume = usedPartQuantities([request]);
    const item = { partSource: PartSource.FIXHOME, partCatalogId: 'part', quantity: 10 };
    expect(consume('cost2', item)).toBe(0);
    expect(consume('cost1', item)).toBe(2);
    expect(consume('cost1', item)).toBe(0);
    request.status = PartRequestStatus.CANCELLED;
    expect(usedPartQuantities([request])('cost1', item)).toBe(0);
  });

  it('keeps PRE_REPAIR and multiple ADDITIONAL approvals separated by approval source and bills USED quantity once', () => {
    const requests = [
      {
        requestType: PartRequestType.PRE_REPAIR,
        status: PartRequestStatus.RECEIVED,
        items: [
          { partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 2, usageStatus: PartUsageStatus.USED },
          { partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 9, usageStatus: PartUsageStatus.RETURNED },
        ],
      },
      {
        requestType: PartRequestType.ADDITIONAL,
        additionalCostId: 'approved-cost-1',
        status: PartRequestStatus.RECEIVED,
        items: [{ partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 1, usageStatus: PartUsageStatus.USED }],
      },
      {
        requestType: PartRequestType.ADDITIONAL,
        additionalCostId: 'approved-cost-2',
        status: PartRequestStatus.COMPLETED,
        items: [{ partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 3, usageStatus: PartUsageStatus.USED }],
      },
      {
        requestType: PartRequestType.ADDITIONAL,
        additionalCostId: 'pending-cost-3',
        status: PartRequestStatus.REQUESTED,
        items: [{ partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 7, usageStatus: PartUsageStatus.USED }],
      },
    ] as PartRequest[];
    const bill = usedPartQuantities(requests);
    const item = { partSource: PartSource.FIXHOME, partCatalogId: 'same-sku', quantity: 5 };

    expect(bill('quotation', item)).toBe(2);
    expect(bill('quotation', item)).toBe(0);
    expect(bill('approved-cost-1', item)).toBe(1);
    expect(bill('approved-cost-1', item)).toBe(0);
    expect(bill('approved-cost-2', item)).toBe(3);
    expect(bill('approved-cost-2', item)).toBe(0);
    expect(bill('pending-cost-3', item)).toBe(0);
  });
});

describe('Additional quote warehouse requests gate requestCompletion', () => {
  function setup(status: PartRequestStatus, usageStatus: PartUsageStatus) {
    const order = { id: 'order', bookingId: 'booking', status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: null };
    const request = { id: 'request', technicianId: 'tech', requestType: PartRequestType.ADDITIONAL, additionalCostId: 'approved-cost', status,
      items: [{ partSource: PartSource.FIXHOME, usageStatus }] };
    const manager = {
      findOne: vi.fn(async () => order),
      findOneBy: vi.fn(async entity => entity === TechnicianAssignment ? { technicianId: 'tech' } : null),
      find: vi.fn(async entity => entity === PartRequest ? [request] : []),
      findOneByOrFail: vi.fn(async entity => entity === Booking ? { pricingModeSnapshot: ServicePricingMode.FIXED_PRICE } : order),
      count: vi.fn(async (entity, { where }) => entity === RepairEvidence && where.type === EvidenceType.AFTER ? 1 : 0),
      update: vi.fn(),
    };
    const generateInvoice = vi.fn();
    const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
      dataSource: { transaction: async work => work(manager) },
      configService: { getInt: vi.fn(async (_key, fallback) => fallback) },
      auditLogService: { logWithManager: vi.fn() },
      notifyCustomerForOrder: vi.fn(), generateInvoice,
    }) as ServiceOrdersService;
    return { service, manager, generateInvoice };
  }

  it.each([
    [PartRequestStatus.REQUESTED, PartUsageStatus.PENDING],
    [PartRequestStatus.READY, PartUsageStatus.USED],
    [PartRequestStatus.DELIVERING, PartUsageStatus.USED],
    [PartRequestStatus.RECEIVED, PartUsageStatus.PENDING],
  ])('blocks completion before handover/usage is resolved (%s, %s)', async (status, usage) => {
    const f = setup(status, usage);
    await expect(f.service.requestCompletion('order', {}, { id: 'tech', role: Role.TECHNICIAN })).rejects.toThrow('USED/RETURNED');
    expect(f.generateInvoice).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
  });

  it.each([PartUsageStatus.USED, PartUsageStatus.RETURNED])('permits the completion request after RECEIVED + %s', async usage => {
    const f = setup(PartRequestStatus.RECEIVED, usage);
    await f.service.requestCompletion('order', {}, { id: 'tech', role: Role.TECHNICIAN });
    expect(f.generateInvoice).toHaveBeenCalledOnce();
    expect(f.manager.update).toHaveBeenCalledWith(ServiceOrder, 'order', expect.objectContaining({ completionRequestedAt: expect.any(Date) }));
  });

  it('still requires AFTER evidence even after the additional parts are resolved', async () => {
    const f = setup(PartRequestStatus.RECEIVED, PartUsageStatus.USED);
    f.manager.count.mockResolvedValue(0);
    await expect(f.service.requestCompletion('order', {}, { id: 'tech', role: Role.TECHNICIAN })).rejects.toThrow('AFTER evidence required');
    expect(f.generateInvoice).not.toHaveBeenCalled();
  });

  it('blocks completion while any unexpired extra awaits approval, before freezing an invoice', async () => {
    const f = setup(PartRequestStatus.RECEIVED, PartUsageStatus.RETURNED);
    f.manager.count.mockImplementation(async (entity, { where }) => entity === RepairEvidence && where.type === EvidenceType.AFTER ? 1
      : entity === AdditionalCostRequest ? 1 : 0);
    await expect(f.service.requestCompletion('order', {}, { id: 'tech', role: Role.TECHNICIAN }))
      .rejects.toMatchObject({ status: 409, response: { code: 'ORDER_INVALID_TRANSITION' } });
    expect(f.generateInvoice).not.toHaveBeenCalled();
    expect(f.manager.update.mock.calls.some(([entity]) => entity === ServiceOrder)).toBe(false);
  });
});

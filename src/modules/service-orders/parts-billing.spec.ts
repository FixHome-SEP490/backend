import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrder } from './entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from './entities/additional-cost-request.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { assertPartsResolved, usedPartQuantities } from '../part-requests/part-request-lifecycle';
import { PartRequestStatus, PartRequestType, PartSource, PartUsageStatus } from '../../shared/enums';

describe('Parts reconciliation at invoice freeze', () => {
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
      findOne: vi.fn(async entity => entity === ServiceOrder ? { bookingId: 'booking' } : entity === Booking ? { pricingModeSnapshot: 'inspection_required' } : entity === Quotation ? { items: [approved('q1', 'used', 1), approved('q2', 'used', 3), approved('q3', 'returned'), approved('q4', 'missing')] } : null),
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

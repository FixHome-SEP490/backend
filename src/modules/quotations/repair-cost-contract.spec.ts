import { describe, expect, it, vi } from 'vitest';
import { QuotationsService } from './quotations.service';
import { Quotation } from './entities/quotation.entity';
import { QuotationItem } from './entities/quotation-item.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { CostItemType, PartSource, Role, ServiceOrderStatus, ServicePricingMode } from '../../shared/enums';

const tech = { id: 'tech', role: Role.TECHNICIAN };
const customer = { id: 'customer', role: Role.CUSTOMER };
const labor = (unitPrice = 449000) => ({ type: CostItemType.LABOR, description: 'Tiền công', quantity: 1, unitPrice });
const part = () => ({ type: CostItemType.PARTS_EQUIPMENT, description: 'Linh kiện', quantity: 2, unitPrice: 1, partSource: PartSource.FIXHOME, partCatalogId: 'sku' });
const supplement = () => ({ reason: 'Thay linh kiện sau khảo sát', items: [labor(10000), part()] });

// Persistence is in memory; the real service performs validation, access and lifecycle decisions.
function setup() {
  const order: any = { id: 'order', bookingId: 'booking', status: ServiceOrderStatus.UNDER_REPAIR,
    completionRequestedAt: null, laborWarrantyDays: 30, laborTotal: 449000, partsTotal: 0, grandTotal: 449000 };
  const booking: any = { id: 'booking', customerId: customer.id, visitGroupId: 'visit', serviceId: 'service',
    pricingModeSnapshot: ServicePricingMode.FIXED_PRICE, fixedUnitPriceSnapshot: '449000', quantity: 1 };
  const quotes: any[] = [];
  const costs: any[] = [];
  let invoice: any = null;
  let sequence = 0;
  const matching = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const one = async (entity: any, { where }: any) => {
    if (entity === ServiceOrder) return matching(order, where) ? order : null;
    if (entity === Booking) return matching(booking, where) ? booking : null;
    if (entity === TechnicianAssignment) return where.technicianId === tech.id ? { technicianId: tech.id, isActive: true } : null;
    if (entity === ArrivalCheckIn) return { result: 'valid' };
    if (entity === Invoice) return invoice;
    if (entity === FixHomePart) return { id: 'sku', name: 'Catalog part', sellingPrice: '200000', warrantyDays: 90 };
    return (entity === Quotation ? quotes : entity === AdditionalCostRequest ? costs : []).find(row => matching(row, where)) ?? null;
  };
  const manager: any = {
    findOne: vi.fn(one), findOneBy: vi.fn((entity, where) => one(entity, { where })),
    findOneOrFail: vi.fn(one), findOneByOrFail: vi.fn((entity, where) => one(entity, { where })),
    count: vi.fn(async (entity, { where }) => (entity === Quotation ? quotes : costs).filter(row => matching(row, where)).length),
    create: (_entity: any, value: any) => ({ ...value }),
    save: vi.fn(async (entity, value) => {
      if (value === undefined) return entity;
      if ([Quotation, AdditionalCostRequest].includes(entity)) {
        const rows = entity === Quotation ? quotes : costs;
        if (!value.id) { value.id = `doc-${++sequence}`; rows.push(value); }
      }
      if ([QuotationItem, AdditionalCostItem].includes(entity)) value.forEach((item: any) => { item.id ??= `item-${++sequence}`; });
      return value;
    }),
    update: vi.fn(async (entity, criteria, changes) => {
      const rows = entity === ServiceOrder ? [order] : entity === Quotation ? quotes : costs;
      for (const row of rows) if (typeof criteria === 'string' ? row.id === criteria : matching(row, criteria)) Object.assign(row, changes);
    }),
  };
  const parts: any = { assertQuotationPartQuantities: vi.fn(), createRequestFromApprovedQuotation: vi.fn(), createAdditionalRequestFromApprovedCost: vi.fn() };
  const audit: any = { logWithManager: vi.fn() };
  const service = new QuotationsService({ findOneBy: where => one(Quotation, { where }) } as any, {} as any,
    { findOneBy: where => one(AdditionalCostRequest, { where }) } as any, {} as any, {} as any, {} as any, {} as any,
    { transaction: work => work(manager) } as any, { getInt: async (_key, fallback) => fallback } as any, audit, parts);
  return { service, order, booking, quotes, costs, manager, parts, audit, freezeInvoice: () => { invoice = { id: 'invoice', serviceOrderId: order.id, paymentStatus: 'unpaid' }; } };
}

describe('E0 repair monetary contract', () => {
  it('keeps fixed base labor-only with a machine-readable validation error and no writes', async () => {
    const s = setup(); s.order.status = ServiceOrderStatus.EN_ROUTE;
    await expect(s.service.createQuotation('order', { items: [labor(), part()] }, tech)).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', message: expect.stringContaining('449.000') }, status: 422,
    });
    expect(s.manager.save).not.toHaveBeenCalled();
    const base = await s.service.createQuotation('order', { items: [labor()] }, tech);
    expect(base).toMatchObject({ laborTotal: 449000, partsTotal: 0, status: 'sent' });
  });

  it('allows valid parts in an inspection base and snapshots catalog price', async () => {
    const s = setup(); s.order.status = ServiceOrderStatus.EN_ROUTE;
    s.booking.pricingModeSnapshot = ServicePricingMode.INSPECTION_REQUIRED;
    const base = await s.service.createQuotation('order', { items: [labor(100000), part()] }, tech);
    expect(base).toMatchObject({ laborTotal: 100000, partsTotal: 400000, items: [
      { type: 'labor', unitPrice: 100000 }, { type: 'parts_equipment', quantity: 2, unitPrice: 200000 },
    ] });
  });

  it('approves extras 1/2/3 independently, revises pending/rejected versions and preserves the approved base', async () => {
    const s = setup(); s.order.status = ServiceOrderStatus.EN_ROUTE;
    const base = await s.service.createQuotation('order', { items: [labor()] }, tech);
    await s.service.decideQuotation(base.id, 'APPROVE', customer);
    const snapshot = JSON.stringify(base);
    s.order.status = ServiceOrderStatus.UNDER_REPAIR;
    for (let n = 1; n <= 3; n++) {
      let cost = await s.service.createAdditionalCost('order', supplement(), tech);
      if (n === 2) {
        const prior = cost;
        cost = await s.service.reviseAdditionalCost(prior.id, supplement(), tech);
        expect(prior.status).toBe('cancelled');
        expect(cost.supersedesId).toBe(prior.id);
      }
      if (n === 3) {
        await s.service.decideAdditionalCost(cost.id, 'REJECT', customer);
        expect(s.order.grandTotal).toBe(1269000);
        cost = await s.service.reviseAdditionalCost(cost.id, supplement(), tech);
      }
      expect(cost.status).toBe('pending_approval');
      await s.service.decideAdditionalCost(cost.id, 'APPROVE', customer);
      await s.service.decideAdditionalCost(cost.id, 'APPROVE', customer);
      await expect(s.service.reviseAdditionalCost(cost.id, supplement(), tech)).rejects.toMatchObject({ response: { code: 'ADDITIONAL_COST_IMMUTABLE' } });
    }
    expect(s.order).toMatchObject({ laborTotal: 479000, partsTotal: 1200000, grandTotal: 1679000 });
    expect(s.costs.filter(cost => cost.status === 'approved')).toHaveLength(3);
    expect(s.parts.createAdditionalRequestFromApprovedCost).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(base)).toBe(snapshot);
    await expect(s.service.createQuotation('order', { items: [labor()] }, tech)).rejects.toThrow();
  });

  it.each([
    ['completion', 'create'], ['completion', 'revise'], ['completion', 'approve'],
    ['invoice', 'create'], ['invoice', 'revise'], ['invoice', 'approve'],
  ])('freezes %s boundary before payment: %s', async (boundary, operation) => {
    const s = setup();
    const pending = await s.service.createAdditionalCost('order', supplement(), tech);
    if (boundary === 'completion') s.order.completionRequestedAt = new Date(); else s.freezeInvoice();
    s.manager.save.mockClear(); s.manager.update.mockClear();
    const result = operation === 'create' ? s.service.createAdditionalCost('order', supplement(), tech)
      : operation === 'revise' ? s.service.reviseAdditionalCost(pending.id, supplement(), tech)
        : s.service.decideAdditionalCost(pending.id, 'APPROVE', customer);
    await expect(result).rejects.toMatchObject({ status: 409 });
    expect(pending.status).toBe('pending_approval');
    expect(s.manager.save).not.toHaveBeenCalled(); expect(s.manager.update).not.toHaveBeenCalled();
  });

  it.each([{ id: 'other-tech', role: Role.TECHNICIAN }, customer, { id: 'manager', role: Role.SERVICE_MANAGER }])('denies unauthorized creation by $id', async actor => {
    const s = setup();
    await expect(s.service.createAdditionalCost('order', supplement(), actor)).rejects.toMatchObject({ status: 403 });
    expect(s.costs).toHaveLength(0);
  });

  it('denies another customer approval and technician revision from another device', async () => {
    const s = setup(); const cost = await s.service.createAdditionalCost('order', supplement(), tech);
    await expect(s.service.decideAdditionalCost(cost.id, 'APPROVE', { ...customer, id: 'other-customer' })).rejects.toMatchObject({ status: 403 });
    await expect(s.service.reviseAdditionalCost(cost.id, supplement(), { ...tech, id: 'other-tech' })).rejects.toMatchObject({ status: 403 });
    expect(cost.status).toBe('pending_approval');
    expect(s.order.grandTotal).toBe(449000);
  });

  it('replays an approved decision after invoice freeze without new money or stock', async () => {
    const s = setup(); const cost = await s.service.createAdditionalCost('order', supplement(), tech);
    await s.service.decideAdditionalCost(cost.id, 'APPROVE', customer);
    s.freezeInvoice();
    const snapshot = JSON.stringify(cost);
    s.manager.save.mockClear(); s.manager.update.mockClear();
    await s.service.decideAdditionalCost(cost.id, 'APPROVE', customer);
    expect(JSON.stringify(cost)).toBe(snapshot);
    expect(s.order.grandTotal).toBe(859000);
    expect(s.parts.createAdditionalRequestFromApprovedCost).toHaveBeenCalledOnce();
    expect(s.manager.save).not.toHaveBeenCalled(); expect(s.manager.update).not.toHaveBeenCalled();
  });
});

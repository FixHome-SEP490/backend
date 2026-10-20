import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { QuotationsService } from '../quotations/quotations.service';
import { PartReturnDiscrepancyDto } from './dto/part-return.dto';
import { PartRequest } from './entities/part-request.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { RepairEvidence } from '../service-orders/entities/repair-evidence.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ArrivalCheckIn } from '../service-orders/entities/arrival-check-in.entity';
import { PartCustody } from './entities/part-custody.entity';
import { PartRequestsService } from './part-requests.service';
import { PartRequestStatus, PartUsageStatus, PaymentStatus, Role, ServiceOrderStatus, ServicePricingMode, CostItemType } from '../../shared/enums';

afterEach(() => vi.unstubAllEnvs());

describe('physical return tracking stays separate from the customer lifecycle (mock storage)', () => {
  it('completes a paid customer order through the real completion gates with physical returns still outstanding', async () => {
    vi.stubEnv('P1_CUSTODY_ENABLED', 'false'); vi.stubEnv('PART_RETURNS_TRACKING_ENABLED', 'true');
    const order = { id: 'order', bookingId: 'booking', code: 'ORDER', status: ServiceOrderStatus.UNDER_REPAIR,
      paymentStatus: PaymentStatus.PAID, completionRequestedAt: new Date() };
    const booking = { id: 'booking', customerId: 'customer', pricingModeSnapshot: ServicePricingMode.FIXED_PRICE };
    const assignment = { technicianId: 'tech', isActive: true };
    const request = { technicianId: 'tech', status: PartRequestStatus.RECEIVED, items: [{ usageStatus: PartUsageStatus.RETURNED }] };
    const custody = { trackingOnly: true, state: { outstandingQty: 1, managerAcceptedQty: 0 } };
    const invoice = { id: 'invoice', paymentStatus: PaymentStatus.PAID };
    const db = {
      findOneBy: vi.fn(async entity => entity === Invoice ? invoice : entity === TechnicianAssignment ? assignment : null),
      findOneByOrFail: vi.fn(async () => booking),
      findOne: vi.fn(async entity => entity === Booking ? booking : entity === TechnicianAssignment ? assignment : null),
      find: vi.fn(async entity => entity === PartRequest ? [request] : entity === PartCustody ? [custody] : []),
      count: vi.fn(async entity => entity === RepairEvidence ? 1 : 0),
      update: vi.fn(), insert: vi.fn(),
    };
    const settlement = { trySettleOrder: vi.fn().mockResolvedValue({ settled: true }) };
    const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
      configService: { getInt: vi.fn().mockResolvedValue(1) },
      auditLogService: { logWithManager: vi.fn() }, settlementService: settlement,
    });
    expect(await service.finalizeIfSatisfied(db, order, { id: 'customer', role: Role.CUSTOMER })).toBe(true);
    expect(order).toMatchObject({ status: ServiceOrderStatus.COMPLETED, paymentStatus: PaymentStatus.PAID });
    expect(custody.state).toEqual({ outstandingQty: 1, managerAcceptedQty: 0 });
    expect(settlement.trySettleOrder).toHaveBeenCalledWith('order', db);
  });

  it('allows the first EN_ROUTE quotation with pending usage; usage itself still requires UNDER_REPAIR', async () => {
    const order = { id: 'order', bookingId: 'booking', status: ServiceOrderStatus.EN_ROUTE, laborWarrantyDays: 0 };
    const booking = { id: 'booking', pricingModeSnapshot: ServicePricingMode.INSPECTION_REQUIRED };
    const pendingRequest = { id: 'request', technicianId: 'tech', status: PartRequestStatus.RECEIVED, items: [{ usageStatus: PartUsageStatus.PENDING }] };
    const db = {
      findOne: vi.fn(async entity => entity === ServiceOrder ? order : null),
      findOneByOrFail: vi.fn(async () => booking),
      findOneBy: vi.fn(async entity => [TechnicianAssignment, ArrivalCheckIn].includes(entity) ? { technicianId: 'tech' } : null),
      find: vi.fn(async entity => entity === PartRequest ? [pendingRequest] : []),
      count: vi.fn().mockResolvedValue(0), update: vi.fn(),
      create: vi.fn((_entity, value) => value), save: vi.fn(async (_entity, value) => Array.isArray(value) ? value : { ...value, id: 'quote' }),
    };
    const service = Object.assign(Object.create(QuotationsService.prototype), {
      dataSource: { transaction: async cb => cb(db) }, auditLogService: { logWithManager: vi.fn() },
      partRequestsService: Object.create(PartRequestsService.prototype),
    });
    const actor = { id: 'tech', role: Role.TECHNICIAN };
    const quote = await service.createQuotation('order', { items: [{ type: CostItemType.LABOR, description: 'Sửa chữa', quantity: 1, unitPrice: 1000 }] }, actor);
    expect(quote).toMatchObject({ status: 'sent', laborTotal: 1000 });
    expect(pendingRequest.items[0].usageStatus).toBe(PartUsageStatus.PENDING);
    const parts = Object.assign(Object.create(PartRequestsService.prototype), {
      dataSource: { transaction: async cb => cb(db) },
    });
    vi.spyOn(parts as any, 'lockRequest').mockResolvedValue({ order, request: pendingRequest });
    await expect(parts.updateItemUsage('request', 'item', { usageStatus: PartUsageStatus.USED }, actor)).rejects.toThrow('UNDER_REPAIR');
  });

  it('validates the manager discrepancy contract and rejects unbounded or absent quantities/reason', () => {
    const valid = { declaredQty: 3, observedQty: 0, expectedVersion: 1, idempotencyKey: 'discrepancy-01', reason: 'Linh kiện bị hỏng' };
    expect(validateSync(plainToInstance(PartReturnDiscrepancyDto, valid))).toHaveLength(0);
    for (const patch of [{ observedQty: -1 }, { declaredQty: 101 }, { reason: '     ' }, { observedQty: undefined }, { expectedVersion: -1 }]) {
      expect(validateSync(plainToInstance(PartReturnDiscrepancyDto, { ...valid, ...patch })).length).toBeGreaterThan(0);
    }
  });
});

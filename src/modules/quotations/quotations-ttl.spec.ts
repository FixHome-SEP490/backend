import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { AdditionalCostStatus, CostItemType, ServiceOrderStatus } from '../../shared/enums';
import { QuotationsService } from './quotations.service';

const CREATED_AT = new Date('2026-10-29T00:00:00.000Z');
const TTL_KEY = 'additional_cost.approval_ttl_minutes';

function setup(config: Map<string, number> = new Map()) {
  let savedCost: AdditionalCostRequest | null = null;
  const order = {
    id: 'order-id',
    bookingId: 'booking-id',
    status: ServiceOrderStatus.UNDER_REPAIR,
    completionRequestedAt: null,
    code: 'FH-1',
  };
  const manager: any = {
    findOne: vi.fn(async (entity: unknown) => entity === ServiceOrder ? order : null),
    findOneBy: vi.fn(async (entity: unknown) => entity === Booking ? { id: 'booking-id', customerId: 'customer-id' } : null),
    findOneOrFail: vi.fn(async () => savedCost),
    create: vi.fn((_entity: unknown, values: unknown) => values),
    save: vi.fn(async (entity: unknown, values?: any) => {
      const payload = values ?? entity;
      if (entity === AdditionalCostRequest) {
        savedCost = { id: 'cost-id', ...payload } as AdditionalCostRequest;
        return savedCost;
      }
      if (payload?.id === 'cost-id') {
        savedCost = payload;
        return savedCost;
      }
      return payload;
    }),
  };
  const service = Object.create(QuotationsService.prototype) as QuotationsService;
  (service as any).configService = {
    getInt: vi.fn(async (key: string, defaultValue: number) => config.get(key) ?? defaultValue),
  };
  (service as any).laborWarranty = vi.fn(async () => ({ days: 30, max: 90 }));
  (service as any).auditLogService = { logWithManager: vi.fn() };
  (service as any).dataSource = { transaction: (work: (tx: any) => unknown) => work(manager) };
  (service as any).additionalCostRepo = { findOneBy: vi.fn(async () => savedCost) };

  return { service, manager, order, getSavedCost: () => savedCost };
}

async function createAdditionalCost(harness: ReturnType<typeof setup>) {
  return (harness.service as any).saveAdditional(
    harness.manager,
    harness.order,
    {
      reason: 'Additional repair work',
      items: [{ type: CostItemType.LABOR, description: 'Repair work', quantity: 1, unitPrice: 1000 }],
    },
    { id: 'technician-id', role: 'technician' },
  ) as Promise<AdditionalCostRequest>;
}

describe('QuotationsService additional-cost approval TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED_AT);
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    { name: 'the canonical 60-minute value', config: new Map([[TTL_KEY, 60]]), expiresAt: '2026-10-29T01:00:00.000Z' },
    { name: 'a custom configured value', config: new Map([[TTL_KEY, 15]]), expiresAt: '2026-10-29T00:15:00.000Z' },
    { name: 'the 60-minute default when unset', config: new Map<string, number>(), expiresAt: '2026-10-29T01:00:00.000Z' },
  ])('sets expiresAt from $name', async ({ config, expiresAt }) => {
    const harness = setup(config);

    const cost = await createAdditionalCost(harness);

    expect(cost.expiresAt.toISOString()).toBe(expiresAt);
  });

  it('allows a decision at 59:59 and expires the request at 60:00 and after', async () => {
    const harness = setup(new Map([[TTL_KEY, 60]]));
    const cost = await createAdditionalCost(harness);
    const customer = { id: 'customer-id', role: 'customer' };

    expect(cost.expiresAt.toISOString()).toBe('2026-10-29T01:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-29T00:59:59.000Z'));
    await expect(harness.service.decideAdditionalCost(cost.id, 'REJECT', customer))
      .resolves.toMatchObject({ status: AdditionalCostStatus.REJECTED });

    cost.status = AdditionalCostStatus.PENDING_APPROVAL;
    cost.decidedAt = null;
    vi.setSystemTime(new Date('2026-10-29T01:00:00.000Z'));
    await expect(harness.service.decideAdditionalCost(cost.id, 'REJECT', customer))
      .rejects.toMatchObject({ status: 409, response: { code: 'ADDITIONAL_COST_ALREADY_DECIDED' } });

    vi.setSystemTime(new Date('2026-10-29T01:00:00.001Z'));
    await expect(harness.service.decideAdditionalCost(cost.id, 'REJECT', customer))
      .rejects.toMatchObject({ status: 409, response: { code: 'ADDITIONAL_COST_ALREADY_DECIDED' } });
  });
});

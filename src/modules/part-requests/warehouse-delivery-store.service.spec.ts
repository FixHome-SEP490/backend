import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WarehouseDeliveryStore } from './warehouse-delivery-store.service';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import { PartRequest, PartRequestItem } from './entities';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { Role } from '../../shared/enums';

function fixture(technicianId?: string) {
  const id = randomUUID(),
    tech = technicianId ?? randomUUID(),
    orderId = randomUUID(),
    partId = randomUUID();
  const events: any[] = [];
  const request = {
    id,
    serviceOrderId: orderId,
    technicianId: tech,
    requestType: 'quotation',
    status: 'requested',
    fulfillmentMethod: 'delivery',
    quotationId: randomUUID(),
  };
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    findOne: vi.fn(async (target: unknown, options: any) => {
      if (target === PartRequest) return request;
      if (target === ServiceOrder)
        return { id: orderId, status: 'under_repair' };
      if (target === TechnicianAssignment)
        return { id: randomUUID(), technicianId: tech, isActive: true };
      if (target === User)
        return {
          id: options.where.id,
          role: Role.TECHNICIAN,
          isActive: true,
          status: 'active',
        };
      if (target === Invoice) return null;
      if (target === Quotation)
        return {
          id: request.quotationId,
          serviceOrderId: orderId,
          technicianId: tech,
          status: 'approved',
          version: 1,
          decidedAt: new Date(),
        };
      if (target === Booking) return { customerId: randomUUID() };
      if (target === WarehouseDeliveryEvent)
        return options.where.commandId
          ? (events.find((e) => e.commandId === options.where.commandId) ??
              null)
          : (events.at(-1) ?? null);
      return null;
    }),
    find: vi.fn(async (target: unknown) =>
      [PartRequestItem, QuotationItem, AdditionalCostItem].includes(
        target as any,
      )
        ? [
            {
              partCatalogId: partId,
              partSource: 'fixhome',
              type: 'parts_equipment',
              quantity: 2,
            },
          ]
        : [],
    ),
    query: vi.fn(async (sql: string) =>
      sql.includes('warehouse_delivery_cohorts')
        ? [
            {
              part_request_id: id,
              service_order_id: orderId,
              technician_id: tech,
            },
          ]
        : [],
    ),
    insert: vi.fn(async (target: unknown, row: any) => {
      if (target === WarehouseDeliveryEvent) events.push(row);
    }),
  };
  const actor = { id: tech, role: Role.TECHNICIAN };
  const command = {
    commandId: randomUUID(),
    expectedVersion: 0,
    kind: 'RESERVE' as const,
  };
  return {
    id,
    tech,
    actor,
    manager,
    command,
    request,
    events,
    store: new WarehouseDeliveryStore(),
  };
}
describe('W3 internal transactional delivery store, closed authority', () => {
  it('accepts seed accounts whose id is not a v4 UUID (W-15)', async () => {
    const f = fixture('c0000000-0000-0000-0000-000000000012');
    const r = await f.store.execute(f.manager, f.id, f.command, f.actor);
    expect(r.state).toMatchObject({ status: 'PENDING_ASSISTANCE', version: 1 });
  });
  it('persists blocked assessment, never reserves stock or infers consent', async () => {
    const f = fixture();
    const r = await f.store.execute(f.manager, f.id, f.command, f.actor);
    expect(r.state).toMatchObject({
      status: 'PENDING_ASSISTANCE',
      reason: 'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
      quantities: [],
      warehouseId: null,
      version: 1,
    });
    expect(f.events).toHaveLength(1);
    expect(
      f.manager.query.mock.calls.some(([sql]: string[]) =>
        /UPDATE warehouse_stock|INSERT INTO warehouse_delivery_movements/.test(
          sql,
        ),
      ),
    ).toBe(false);
  });
  it('replays identical command and rejects command reuse/CAS conflict', async () => {
    const f = fixture();
    await f.store.execute(f.manager, f.id, f.command, f.actor);
    expect(
      (await f.store.execute(f.manager, f.id, f.command, f.actor)).replayed,
    ).toBe(true);
    await expect(
      f.store.execute(
        f.manager,
        f.id,
        { ...f.command, expectedVersion: 1 },
        f.actor,
      ),
    ).rejects.toThrow('COMMAND_CONFLICT');
    await expect(
      f.store.execute(
        f.manager,
        f.id,
        { ...f.command, commandId: randomUUID() },
        f.actor,
      ),
    ).rejects.toThrow('CAS_CONFLICT');
    expect(f.events).toHaveLength(1);
  });
  it.each([
    'ISSUE_TO_COURIER',
    'COURIER_DISPATCH',
    'TECHNICIAN_RECEIPT',
    'RELEASE',
  ] as const)('keeps %s closed even with metadata', async (kind) => {
    const f = fixture();
    await expect(
      f.store.execute(f.manager, f.id, { ...f.command, kind }, f.actor),
    ).rejects.toThrow('PHYSICAL_ACTIVATION_CLOSED');
    expect(f.events).toHaveLength(0);
  });
  it('requires a real active transaction', async () => {
    const f = fixture();
    f.manager.queryRunner.isTransactionActive = false;
    await expect(
      f.store.execute(f.manager, f.id, f.command, f.actor),
    ).rejects.toThrow('TRANSACTION_REQUIRED');
    expect(f.manager.findOne).not.toHaveBeenCalled();
  });
  it('denies customer/admin/foreign technician and rechecks DB role', async () => {
    const f = fixture();
    for (const actor of [
      { id: f.tech, role: Role.CUSTOMER },
      { id: f.tech, role: Role.ADMIN },
      { id: randomUUID(), role: Role.TECHNICIAN },
    ]) {
      await expect(
        f.store.execute(f.manager, f.id, f.command, actor),
      ).rejects.toThrow('ACTOR_DENIED');
    }
    f.manager.findOne
      .mockImplementationOnce(async () => f.request)
      .mockImplementationOnce(async () => ({
        id: f.request.serviceOrderId,
        status: 'under_repair',
      }))
      .mockImplementationOnce(async () => null);
    await expect(
      f.store.execute(f.manager, f.id, f.command, f.actor),
    ).rejects.toThrow();
    expect(f.events).toHaveLength(0);
  });
  it('refuses legacy/non-enrolled request without journal writes', async () => {
    const f = fixture();
    f.manager.query.mockResolvedValue([]);
    await expect(
      f.store.execute(f.manager, f.id, f.command, f.actor),
    ).rejects.toThrow('LEGACY_REQUEST');
    expect(f.events).toHaveLength(0);
  });
  it('propagates persistence failure for caller rollback', async () => {
    const f = fixture();
    f.manager.insert.mockRejectedValue(new Error('database failed'));
    await expect(
      f.store.execute(f.manager, f.id, f.command, f.actor),
    ).rejects.toThrow('database failed');
  });
  it('locks order then technician then request; no private transaction or commit', async () => {
    const f = fixture();
    await f.store.execute(f.manager, f.id, f.command, f.actor);
    const targets = f.manager.findOne.mock.calls
      .filter(([, o]: any[]) => o.lock?.mode === 'pessimistic_write')
      .map(([t]: any[]) => t);
    expect(targets.slice(0, 3)).toEqual([ServiceOrder, User, PartRequest]);
  });
  it('rejects payload authority, invalid command/version and unknown kinds', async () => {
    for (const extra of [
      { shippingApproved: true },
      { expectedVersion: -1 },
      { commandId: 'x' },
      { kind: 'AUTO_RECEIVE' },
    ]) {
      const f = fixture();
      await expect(
        f.store.execute(
          f.manager,
          f.id,
          { ...f.command, ...extra } as any,
          f.actor,
        ),
      ).rejects.toThrow('COMMAND_INVALID');
      expect(f.events).toHaveLength(0);
    }
  });
  it('keeps mismatched source SKU/quantity unverified', async () => {
    const f = fixture();
    const find = f.manager.find.getMockImplementation()!;
    f.manager.find.mockImplementation((target: unknown) =>
      target === QuotationItem
        ? [
            {
              partCatalogId: randomUUID(),
              partSource: 'fixhome',
              type: 'parts_equipment',
              quantity: 2,
            },
          ]
        : find(target),
    );
    expect(
      (await f.store.execute(f.manager, f.id, f.command, f.actor)).state.reason,
    ).toBe('PARTS_SOURCE_UNVERIFIED');
  });
  it('does not mistake another customers additional-cost approval for this customer', async () => {
    const f = fixture();
    const request: any = f.request;
    request.requestType = 'additional';
    request.additionalCostId = randomUUID();
    request.quotationId = null;
    const original = f.manager.findOne.getMockImplementation()!;
    f.manager.findOne.mockImplementation((target: unknown, options: any) =>
      target === AdditionalCostRequest
        ? {
            id: request.additionalCostId,
            serviceOrderId: request.serviceOrderId,
            technicianId: f.tech,
            status: 'approved',
            decidedAt: new Date(),
            decidedByCustomerId: f.tech,
          }
        : original(target, options),
    );
    expect(
      (await f.store.execute(f.manager, f.id, f.command, f.actor)).state.reason,
    ).toBe('PARTS_SOURCE_UNVERIFIED');
  });
});

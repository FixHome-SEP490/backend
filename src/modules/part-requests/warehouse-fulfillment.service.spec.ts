import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { releaseWarehouseReservations, WarehouseFulfillmentService } from './warehouse-fulfillment.service';
import { WarehouseAllocation } from './entities/warehouse-allocation.entity';
import { PartRequest, PartRequestItem } from './entities';
import { Warehouse } from '../warehouses/entities';
import { Role, FulfillmentMethod, PartRequestStatus, PartSource, PartRequestType } from '../../shared/enums';
import { User } from '../users/entities/user.entity';

function setup(status = 'reserved') {
  const allocation = { partRequestId: 'request', warehouseId: 'warehouse', responsibleUserId: 'sm', technicianId: 'tech', status,
    tokenVersion: 0, tokenHash: null, tokenExpiresAt: null, receiptHash: null, receiptExpiresAt: null };
  const request = { id: 'request', serviceOrderId: 'order', technicianId: 'tech', requestType: PartRequestType.PRE_REPAIR, status: PartRequestStatus.REQUESTED,
    fulfillmentMethod: FulfillmentMethod.PICKUP, items: [{ id: 'item', partCatalogId: 'sku', partSource: PartSource.FIXHOME, quantity: 2 }] };
  const manager = { findOne: vi.fn(async (entity: unknown): Promise<any> => entity === WarehouseAllocation ? allocation : entity === PartRequest ? request :
    entity === Warehouse ? { id: 'warehouse', responsibleUserId: 'sm', status: 'active' } : null),
    find: vi.fn(async (entity: unknown): Promise<any[]> => entity === PartRequestItem ? request.items : []), save: vi.fn(async (_e, row) => row),
    query: vi.fn(async (_sql?: string): Promise<any[]> => []), insert: vi.fn() };
  return { service: new WarehouseFulfillmentService(), manager, allocation, request };
}

describe('W2 physical authority and legacy safety', () => {
  it('shows approximate straight-line km from the booking without claiming verified road distance or ETA', async () => {
    const { service, manager, allocation } = setup();
    manager.findOne.mockImplementation(async (entity: unknown): Promise<any> =>
      entity === WarehouseAllocation ? allocation :
      entity === Warehouse ? { id: 'warehouse', responsibleUserId: 'sm', status: 'active', latitude: '10.810', longitude: '106.740' } : null);
    manager.query.mockResolvedValue([{ latitude: '10.800', longitude: '106.730' }]);
    const view = await service.view(manager as never, 'request');
    expect(view).toMatchObject({
      mode: 'warehouse', distanceNotVerified: true, reviewRequired: true,
      estimatedStraightLineKm: expect.any(Number), distanceReference: 'booking_snapshot',
    });
    expect((view as any).estimatedStraightLineKm).toBeGreaterThan(0);
  });

  it('does not fabricate km when warehouse or booking coordinates are missing', async () => {
    const { service, manager } = setup();
    const view = await service.view(manager as never, 'request');
    expect(view).toMatchObject({ mode: 'warehouse', distanceNotVerified: true, estimatedStraightLineKm: null, distanceReference: null });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it.each([

    { name: 'automatic booking still selects the first whole-stock warehouse', actor: { id: 'system', role: 'system' }, stockB: 3, automatic: true, expected: 'warehouse-a' },
  ])('$name', async ({ actor, stockB, automatic, expected }) => {
    const { service, manager, request, allocation } = setup('manual_assistance');
    Object.assign(allocation, { warehouseId: null, responsibleUserId: null });
    const candidates = [{ id: 'warehouse-a', responsibleUserId: 'sm-a' }, { id: 'warehouse-b', responsibleUserId: 'sm-b' }];
    manager.findOne.mockImplementation(async (entity, options?: any) => entity === WarehouseAllocation ? allocation
      : entity === Warehouse ? { id: options?.where?.id, responsibleUserId: options?.where?.id === 'warehouse-b' ? 'sm-b' : 'sm-a', status: 'active' }
      : null);
    manager.query.mockImplementation(async (sql?: string) => {
      if (sql?.startsWith('SELECT id, fingerprint')) return [];
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) return [{ id: 'command' }];
      if (sql?.includes('FROM warehouses w JOIN users')) return candidates;
      if (sql?.includes('FROM warehouse_stock s WHERE')) return [
        { warehouseId: 'warehouse-a', partId: 'sku', onHand: 3, reserved: 0 },
        { warehouseId: 'warehouse-b', partId: 'sku', onHand: stockB, reserved: 0 },
      ];
      if (sql?.startsWith('SELECT on_hand AS')) return [{ onHand: 3, reserved: 0 }];
      return [];
    });
    await service.reserve(manager as never, request as never, actor, 'reserve-test', automatic);
    expect(allocation.warehouseId).toBe(expected);
    expect(allocation.responsibleUserId).toBe(expected === 'warehouse-b' ? 'sm-b' : 'sm-a');
    expect(manager.query.mock.calls.some(([sql, params]: any[]) => sql?.startsWith('UPDATE warehouse_stock') && params?.[0] === expected)).toBe(true);
    expect(manager.query.mock.calls.some(([sql, params]: any[]) => sql?.startsWith('UPDATE warehouse_stock') && params?.[0] !== expected)).toBe(false);
  });

  it('auto-selects nearest stock-sufficient warehouse and never holds stock in another', async () => {
    const { service, manager, request, allocation } = setup('manual_assistance');
    Object.assign(allocation, { warehouseId: null, responsibleUserId: null });
    manager.query.mockImplementation(async (sql?: string) => {
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) return [{ id: 'command' }];
      if (sql?.includes('FROM service_orders o JOIN bookings b')) return [{
        lastLocationAt: null, liveLatitude: null, liveLongitude: null,
        profileLatitude: '10.810', profileLongitude: '106.740',
        bookingLatitude: '10.770', bookingLongitude: '106.690',
      }];
      if (sql?.includes('FROM warehouses w JOIN users')) return [
        { id: 'warehouse-a', responsibleUserId: 'sm-a', latitude: '10.770', longitude: '106.690' },
        { id: 'warehouse-b', responsibleUserId: 'sm-b', latitude: '10.811', longitude: '106.741' },
      ];
      if (sql?.includes('FROM warehouse_stock s WHERE')) return [
        { warehouseId: 'warehouse-a', partId: 'sku', onHand: 4, reserved: 0 },
        { warehouseId: 'warehouse-b', partId: 'sku', onHand: 4, reserved: 0 },
      ];
      if (sql?.startsWith('SELECT on_hand AS')) return [{ onHand: 4, reserved: 0 }];
      return [];
    });
    await service.reserve(manager as never, request as never, { id: 'system', role: 'system' }, 'nearest', true);
    expect(allocation.warehouseId).toBe('warehouse-b');
    expect(manager.query.mock.calls.filter(([sql]) => sql?.startsWith('UPDATE warehouse_stock'))).toHaveLength(1);
    expect(manager.query.mock.calls.some(([sql, params]: any[]) =>
      sql?.startsWith('UPDATE warehouse_stock') && params?.[0] === 'warehouse-b')).toBe(true);
  });

  it('notifies only the technician and never reserves or delegates when every warehouse lacks stock', async () => {
    const { service, manager, request, allocation } = setup('manual_assistance');
    Object.assign(allocation, { warehouseId: null, responsibleUserId: null });
    manager.query.mockImplementation(async (sql?: string) => {
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) return [{ id: 'command' }];
      if (sql?.includes('FROM warehouses w JOIN users')) return [
        { id: 'warehouse-a', responsibleUserId: 'sm-a', latitude: '10.77', longitude: '106.7' },
      ];
      if (sql?.includes('FROM warehouse_stock s WHERE')) return [
        { warehouseId: 'warehouse-a', partId: 'sku', onHand: 1, reserved: 0 },
      ];
      return [];
    });
    const result = await service.reserve(manager as never, request as never, { id: 'tech', role: Role.TECHNICIAN }, 'auto:no-stock', true);
    expect(result).toMatchObject({ status: 'stock_unavailable', warehouseId: null, stockUnavailable: true });
    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(manager.insert.mock.calls[0][1]).toMatchObject({ userId: 'tech', type: 'PART_REQUEST_STOCK_UNAVAILABLE' });
    expect(manager.query.mock.calls.some(([sql]) => sql?.startsWith('UPDATE warehouse_stock'))).toBe(false);
    expect(allocation.status).toBe('manual_assistance'); // DB CHECK unchanged; API translates to stock_unavailable.
    await expect(service.reserve(manager as never, request as never,
      { id: 'sm-a', role: Role.SERVICE_MANAGER }, 'manual-retry')).rejects.toThrow('Không có kho đủ linh kiện');
    expect(manager.insert).toHaveBeenCalledTimes(1);
  });

  it('never reserves another manager warehouse when acting SM has insufficient stock', async () => {
    const { service, manager, request, allocation } = setup('manual_assistance');
    Object.assign(allocation, { warehouseId: null, responsibleUserId: null });
    manager.query.mockImplementation(async (sql?: string) => {
      if (sql?.startsWith('SELECT id, fingerprint')) return [];
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) return [{ id: 'command' }];
      if (sql?.includes('FROM warehouses w JOIN users')) return [
        { id: 'warehouse-a', responsibleUserId: 'sm-a' }, { id: 'warehouse-b', responsibleUserId: 'sm-b' },
      ];
      if (sql?.includes('FROM warehouse_stock s WHERE')) return [
        { warehouseId: 'warehouse-a', partId: 'sku', onHand: 3, reserved: 0 },
        { warehouseId: 'warehouse-b', partId: 'sku', onHand: 1, reserved: 0 },
      ];
      return [];
    });
    await expect(service.reserve(manager as never, request as never,
      { id: 'sm-b', role: Role.SERVICE_MANAGER }, 'no-own-stock')).rejects.toThrow();
    expect(manager.query.mock.calls.some(([sql]) => sql?.startsWith('UPDATE warehouse_stock'))).toBe(false);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('does not enroll Warranty pickup requests or mutate their warehouse state', async () => {
    const { service, manager, request } = setup();
    request.requestType = PartRequestType.WARRANTY;
    await expect(service.enroll(manager as never, request as never, { id: 'sm', role: Role.SERVICE_MANAGER })).resolves.toBeUndefined();
    expect(manager.insert).not.toHaveBeenCalled(); expect(manager.query).not.toHaveBeenCalled();
  });
  it('keeps historical requests legacy without inventory mutation', async () => {
    const { service, manager, request } = setup();
    manager.findOne.mockResolvedValue(null);
    await expect(service.acknowledge(manager as never, request as never, 'token')).resolves.toBe(false);
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
  it('forbids tech acknowledgement before physical SM handover', async () => {
    const { service, manager, request } = setup('ready');
    await expect(service.acknowledge(manager as never, request as never, 'token')).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });
  it('forbids unrelated SM and Admin physical handover authority', async () => {
    const { service, manager, allocation } = setup();
    await expect(service.requireManager(manager as never, allocation as never, { id: 'other', role: Role.SERVICE_MANAGER })).rejects.toThrow();
    await expect(service.requireManager(manager as never, allocation as never, { id: 'admin', role: Role.ADMIN })).rejects.toThrow();
  });
  it('never releases/restocks inventory after physical handover on order cancellation', async () => {
    const { service, manager, request, allocation } = setup('handed_over');
    await service.release(manager as never, request as never, { id: 'sm', role: Role.SERVICE_MANAGER });
    expect(allocation.status).toBe('handed_over');
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
  it('rejects expired receipt QR and replayed receipt without stock writes', async () => {
    const { service, manager, request, allocation } = setup('handed_over');
    allocation.receiptHash = 'hash' as never;
    allocation.receiptExpiresAt = new Date(0) as never;
    await expect(service.acknowledge(manager as never, request as never, 'token')).rejects.toThrow();
    allocation.status = 'received';
    await expect(service.acknowledge(manager as never, request as never, 'token')).rejects.toThrow();
    expect(manager.query).not.toHaveBeenCalled();
  });
  it('recovers a lost handover response by rotating only receipt, then acknowledges once', async () => {
    const { service, manager, request, allocation } = setup('handed_over');
    manager.findOne.mockImplementation(async entity => entity === WarehouseAllocation ? allocation : entity === User ? { id: 'sm' } :
      entity === Warehouse ? { id: 'warehouse', responsibleUserId: 'sm', status: 'active' } : request);
    manager.query.mockImplementation(async sql => sql?.startsWith('INSERT INTO warehouse_fulfillment_commands') ? [{ id: 'command' }] : []);
    const first = await service.qr(manager as never, request as never, { id: 'sm', role: Role.SERVICE_MANAGER }, 'recovery-1');
    const recovered = await service.qr(manager as never, request as never, { id: 'sm', role: Role.SERVICE_MANAGER }, 'recovery-2');
    expect(recovered.qrToken).toBeTruthy(); expect(recovered.qrToken).not.toBe(first.qrToken);
    expect(allocation.status).toBe('handed_over'); expect(request.status).toBe(PartRequestStatus.REQUESTED);
    expect(manager.query.mock.calls.some(([sql]) => /warehouse_stock|warehouse_fulfillment_movements/.test(sql ?? ''))).toBe(false);
    await expect(service.acknowledge(manager as never, request as never, first.qrToken!)).rejects.toThrow();
    await expect(service.acknowledge(manager as never, request as never, recovered.qrToken!)).resolves.toBe(true);
    await expect(service.acknowledge(manager as never, request as never, recovered.qrToken!)).rejects.toThrow();
  });
  it('replays QR creation without disclosing a token or writing a new allocation', async () => {
    const { service, manager, request, allocation } = setup('ready');
    manager.findOne.mockImplementation(async entity => entity === WarehouseAllocation ? allocation : entity === User ? { id: 'sm' } :
      entity === Warehouse ? { id: 'warehouse', responsibleUserId: 'sm', status: 'active' } : request);
    // Capture the immutable command fingerprint of the first successful request.
    let prior: { id: string; fingerprint: string } | undefined;
    manager.query.mockImplementation(async (sql, params?: unknown[]) => {
      if (sql?.startsWith('SELECT id, fingerprint')) return prior ? [prior] : [];
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) { prior = { id: 'command', fingerprint: String(params?.[4]) }; return [prior]; }
      return [];
    });
    const actor = { id: 'sm', role: Role.SERVICE_MANAGER };
    const first = await service.qr(manager as never, request as never, actor, 'same-key');
    expect(first.qrToken).toHaveLength(64); const version = allocation.tokenVersion;
    manager.save.mockClear();
    expect((await service.qr(manager as never, request as never, actor, 'same-key')).qrToken).toBeNull();
    expect(allocation.tokenVersion).toBe(version); expect(manager.save).not.toHaveBeenCalled();
  });
  it('bulk lifecycle release locks technicians before requests and releases each reservation once', async () => {
    const { manager, request, allocation } = setup('reserved');
    const stock = { onHand: 2, reserved: 2 };
    const order: string[] = [];
    manager.find.mockImplementation(async entity => entity === PartRequest ? [request] : entity === WarehouseAllocation ? [allocation] : request.items);
    manager.findOne.mockImplementation(async entity => {
      order.push((entity as { name: string }).name);
      return entity === User ? { id: 'tech' } : entity === WarehouseAllocation ? allocation : request;
    });
    manager.query.mockImplementation(async (sql, params?: any[]) => {
      if (sql?.startsWith('INSERT INTO warehouse_fulfillment_commands')) return [{ id: 'release' }];
      if (sql?.startsWith('SELECT on_hand')) return [stock];
      if (sql?.startsWith('UPDATE warehouse_stock')) { stock.onHand = params![2]; stock.reserved = params![3]; }
      return [];
    });
    await releaseWarehouseReservations(manager as never, { serviceOrderId: 'order' });
    await releaseWarehouseReservations(manager as never, { serviceOrderId: 'order' });
    expect(stock).toEqual({ onHand: 2, reserved: 0 }); expect(allocation.status).toBe('released');
    expect(order.indexOf('User')).toBeLessThan(order.indexOf('PartRequest'));
    expect(manager.query.mock.calls.filter(([sql]) => sql?.startsWith('UPDATE warehouse_stock'))).toHaveLength(1);
  });
  it('allows the current replacement warehouse SM to rotate a receipt bound to the outgoing SM', async () => {
    const { service, manager, request, allocation } = setup('handed_over');
    allocation.responsibleUserId = 'previous-sm';
    manager.findOne.mockImplementation(async entity => entity === WarehouseAllocation ? allocation : entity === User ? { id: 'sm' } :
      entity === Warehouse ? { id: 'warehouse', responsibleUserId: 'sm', status: 'active' } : request);
    manager.query.mockImplementation(async sql => sql?.startsWith('INSERT INTO warehouse_fulfillment_commands') ? [{ id: 'command' }] : []);
    const result = await service.qr(manager as never, request as never, { id: 'sm', role: Role.SERVICE_MANAGER }, 'replacement-receipt');
    expect(result.qrToken).toHaveLength(64); expect(allocation.responsibleUserId).toBe('sm');
    expect(allocation.status).toBe('handed_over');
    expect(manager.query.mock.calls.some(([sql]) => /warehouse_stock|warehouse_fulfillment_movements/.test(sql ?? ''))).toBe(false);
  });
});

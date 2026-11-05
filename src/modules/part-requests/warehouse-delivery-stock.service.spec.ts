import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WarehouseDeliveryStock } from './warehouse-delivery-stock.service';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities';
import { advanceDelivery } from './warehouse-delivery.policy';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';

// Hypothetical admitted event/gate doubles exercise the dormant atomic writer. PostgreSQL
// CHECK/trigger gates cannot be opened this way; these are NOT live approval/PG evidence.
function fixture() {
  const id = randomUUID(),
    commandId = randomUUID(),
    tech = randomUUID(),
    sm = randomUUID(),
    warehouseId = randomUUID();
  const items = ['a', 'b'].map((partCatalogId) => ({
    partCatalogId,
    partSource: 'fixhome',
    quantity: 2,
  }));
  const state: any = {
    version: 1,
    status: 'RESERVED',
    reason: null,
    warehouseId,
    responsibleUserId: sm,
    quantities: items.map((i) => ({
      partId: i.partCatalogId,
      quantity: i.quantity,
    })),
    courierReference: null,
    evidence: [],
  };
  const event: any = {
    partRequestId: id,
    commandId,
    kind: 'RESERVE',
    expectedVersion: 0,
    resultVersion: 1,
    snapshot: state,
    actorUserId: tech,
    actorRole: 'technician',
  };
  const stocks = items.map((i) => ({
    partId: i.partCatalogId,
    onHand: 2,
    reserved: 0,
  }));
  let gate = true,
    prior: any[] = [],
    own: any[] = [],
    preceding: any = null;
  const m: any = {
    queryRunner: { isTransactionActive: true },
    findOneOrFail: vi.fn(async (target: unknown) =>
      target === WarehouseDeliveryEvent
        ? event
        : target === Warehouse
          ? { id: warehouseId, responsibleUserId: sm, status: 'active' }
          : target === User
            ? { id: tech, role: 'technician', isActive: true, status: 'active' }
            : target === ServiceOrder
              ? { id: 'order', status: 'under_repair' }
              : {
                  id,
                  technicianId: tech,
                  serviceOrderId: 'order',
                  fulfillmentMethod: 'delivery',
                },
    ),
    findOne: vi.fn(async (target: unknown) =>
      target === User
        ? { id: sm, role: 'service_manager', isActive: true, status: 'active' }
        : target === TechnicianAssignment
          ? { id: 'assigned' }
          : target === WarehouseDeliveryEvent
            ? preceding
            : null,
    ),
    find: vi.fn(async () => items),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT enabled')) return [{ enabled: gate }];
      if (sql.includes('FROM warehouse_stock')) return stocks;
      if (sql.includes('sum(reservation_delta)')) return own;
      if (sql.includes('SELECT part_id FROM warehouse_delivery_movements'))
        return prior;
      return [];
    }),
  };
  return {
    m,
    id,
    commandId,
    event,
    state,
    stocks,
    items,
    run: () =>
      new WarehouseDeliveryStock().applyRecordedEvent(m, id, commandId),
    gate: (v: boolean) => {
      gate = v;
    },
    prior: (v: any[]) => {
      prior = v;
    },
    own: (v: any[]) => {
      own = v;
    },
    preceding: (v: any) => {
      preceding = v;
    },
  };
}
describe('dormant DELIVERY stock writer', () => {
  it('rejects closed/missing gate before any request or stock write', async () => {
    const f = fixture();
    f.gate(false);
    await expect(f.run()).rejects.toThrow('ACTIVATION_CLOSED');
    expect(f.m.findOneOrFail).not.toHaveBeenCalled();
  });
  it('preflights all SKU balances before the first write', async () => {
    const f = fixture();
    f.stocks[1].onHand = 1;
    await expect(f.run()).rejects.toThrow('Invalid warehouse balance');
    expect(
      f.m.query.mock.calls.some(([sql]: string[]) => sql.startsWith('UPDATE')),
    ).toBe(false);
  });
  it('increments only reserved for both SKU and records both movements', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ replayed: false });
    const writes = f.m.query.mock.calls.filter(([sql]: string[]) =>
      sql.startsWith('UPDATE warehouse_stock'),
    );
    expect(writes).toHaveLength(0); // DB movement trigger owns the delta and balance atomically.
    expect(
      f.m.query.mock.calls.filter(([sql]: string[]) =>
        sql.startsWith('INSERT INTO warehouse_delivery_movements'),
      ),
    ).toHaveLength(2);
  });
  it('replays whole movement receipts without another delta and rejects partial receipts', async () => {
    const f = fixture();
    f.prior([{ part_id: 'a' }, { part_id: 'b' }]);
    expect(await f.run()).toEqual({ replayed: true });
    f.prior([{ part_id: 'a' }]);
    await expect(f.run()).rejects.toThrow('PARTIAL_JOURNAL');
  });
  it('requires current warehouse responsibility and full quantity binding', async () => {
    const f = fixture();
    f.items[0].quantity = 1;
    await expect(f.run()).rejects.toThrow('QUANTITIES_CHANGED');
    const g = fixture();
    const findOne = g.m.findOne.getMockImplementation()!;
    g.m.findOne.mockImplementation((target: unknown) =>
      target === User ? { id: randomUUID(), role: 'admin' } : findOne(target),
    );
    await expect(g.run()).rejects.toThrow('WAREHOUSE_DENIED');
  });
  it('requires own prior reservation, separate issue proof and matching actor before stock ISSUE', async () => {
    const f = fixture();
    f.preceding({ snapshot: f.state });
    f.event.snapshot = advanceDelivery(f.state, 'ISSUE_TO_COURIER', {
      courierReference: 'courier:123',
      evidenceRef: 'private:123',
      contentDigest: 'a'.repeat(64),
    });
    f.event.kind = 'ISSUE_TO_COURIER';
    f.event.expectedVersion = 1;
    f.event.resultVersion = 2;
    f.event.actorRole = 'service_manager';
    f.event.actorUserId = f.state.responsibleUserId;
    await expect(f.run()).rejects.toThrow('RESERVATION_PROOF_REQUIRED');
    f.own([
      { partId: 'a', reserved: 2, issued: false },
      { partId: 'b', reserved: 2, issued: false },
    ]);
    f.stocks.forEach((s) => {
      s.reserved = 2;
    });
    await f.run();
    const writes = f.m.query.mock.calls.filter(([sql]: string[]) =>
      sql.startsWith('UPDATE warehouse_stock'),
    );
    expect(writes).toHaveLength(0);
    expect(
      f.m.query.mock.calls
        .filter(([sql]: string[]) =>
          sql.startsWith('INSERT INTO warehouse_delivery_movements'),
        )
        .every(([, args]: any[]) => args[7] === 0 && args[8] === 0),
    ).toBe(true);
  });
  it('requires transaction and propagates movement INSERT failure for rollback', async () => {
    const f = fixture();
    f.m.queryRunner.isTransactionActive = false;
    await expect(f.run()).rejects.toThrow('TRANSACTION_REQUIRED');
    const g = fixture();
    const query = g.m.query.getMockImplementation()!;
    g.m.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.startsWith('INSERT INTO warehouse_delivery_movements'))
        throw new Error('movement failed');
      return query(sql, args);
    });
    await expect(g.run()).rejects.toThrow('movement failed');
  });
});

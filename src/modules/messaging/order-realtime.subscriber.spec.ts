import { describe, expect, it, vi } from 'vitest';
import { OrderRealtimeSubscriber } from './order-realtime.subscriber';

const ORDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';

function harness() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM service_orders so')) {
      return [{ id: ORDER, status: 'completed', booking_id: 'b1', customer_id: 'c1', technician_ids: ['t1', 't2'] }];
    }
    if (sql.includes('FROM conversations')) return [{ id: 'conv1', customer_id: 'c1', technician_id: 't1' }];
    return [];
  });
  const dataSource = { subscribers: [] as unknown[], query };
  const gateway = { server: {}, emitOrderUpdated: vi.fn(), emitConversationTouched: vi.fn() };
  const subscriber = new OrderRealtimeSubscriber(dataSource as never, gateway as never);
  subscriber.onModuleInit();
  const runner = { isTransactionActive: true };
  const insert = (tableName: string, entity: Record<string, unknown>) =>
    subscriber.afterInsert({ queryRunner: runner, metadata: { tableName }, entity } as never);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { subscriber, dataSource, gateway, runner, insert, query, settle };
}

describe('Realtime order updates (PO 18/10/2026)', () => {
  it('registers once and announces an order only after its transaction commits', async () => {
    const h = harness();
    h.subscriber.onModuleInit();
    expect(h.dataSource.subscribers).toEqual([h.subscriber]);

    h.insert('order_status_history', { serviceOrderId: ORDER, toStatus: 'completed' });
    h.insert('invoices', { serviceOrderId: ORDER });
    await h.settle();
    expect(h.gateway.emitOrderUpdated).not.toHaveBeenCalled();

    h.runner.isTransactionActive = false;
    h.subscriber.afterTransactionCommit({ queryRunner: h.runner } as never);
    await h.settle();
    // One announcement for the order however many rows touched it, to the customer and every technician who held it.
    expect(h.gateway.emitOrderUpdated).toHaveBeenCalledTimes(1);
    expect(h.gateway.emitOrderUpdated).toHaveBeenCalledWith(['c1', 't1', 't2'], { serviceOrderId: ORDER, bookingId: 'b1', status: 'completed' });
    // The chat of the order refreshes too: whether it is open follows the order.
    expect(h.gateway.emitConversationTouched).toHaveBeenCalledWith(['c1', 't1'], 'conv1');
  });

  it('waits for the outer commit when a savepoint is released', async () => {
    const h = harness();
    h.insert('order_status_history', { serviceOrderId: ORDER });
    h.subscriber.afterTransactionCommit({ queryRunner: h.runner } as never); // still active: nested
    await h.settle();
    expect(h.gateway.emitOrderUpdated).not.toHaveBeenCalled();
  });

  it('drops what a rolled-back transaction touched', async () => {
    const h = harness();
    h.insert('order_status_history', { serviceOrderId: ORDER });
    h.runner.isTransactionActive = false;
    h.subscriber.afterTransactionRollback({ queryRunner: h.runner } as never);
    h.subscriber.afterTransactionCommit({ queryRunner: h.runner } as never);
    await h.settle();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('announces a write outside a transaction at once, reads the order id of the orders table itself, and ignores other tables', async () => {
    const h = harness();
    h.runner.isTransactionActive = false;
    h.insert('service_orders', { id: ORDER, serviceOrderId: OTHER });
    await h.settle();
    expect(h.query.mock.calls[0][1]).toEqual([[ORDER]]);

    h.query.mockClear();
    h.insert('messages', { serviceOrderId: ORDER });
    h.insert('quotations', { serviceOrderId: 42 });
    h.subscriber.afterUpdate({ queryRunner: h.runner, metadata: { tableName: 'quotations' }, entity: { status: 'approved' } } as never);
    await h.settle();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('never fails the write when announcing does', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(new Error('database gone'));
    await expect(h.subscriber.publish([ORDER])).resolves.toBeUndefined();
    expect(h.gateway.emitOrderUpdated).not.toHaveBeenCalled();
  });

  it('does nothing without a socket server (tests, workers)', async () => {
    const h = harness();
    (h.gateway as { server?: unknown }).server = undefined;
    await h.subscriber.publish([ORDER]);
    expect(h.query).not.toHaveBeenCalled();
  });
});

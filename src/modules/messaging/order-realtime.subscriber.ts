import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  UpdateEvent,
} from 'typeorm';
import { MessagingGateway } from './messaging.gateway';

/**
 * Rows whose writes change what an order screen shows. Every status change of a
 * service order writes an order_status_history row in the same transaction,
 * whichever module makes it, so watching that table alone already catches every
 * transition; the others carry the steps in between (quotation, invoice,
 * payment, photos, check-in, warranty).
 */
const ORDER_TABLES = new Set([
  'order_status_history',
  'service_orders',
  'invoices',
  'quotations',
  'additional_cost_requests',
  'cash_settlements',
  'repair_evidences',
  'arrival_check_ins',
  'part_requests',
  'warranty_claims',
]);

/**
 * Realtime order updates (PO 18/10/2026: the technician's job page and the
 * customer's order pages follow status changes live).
 *
 * Collects the orders a transaction touched and announces them only after it
 * commits (spec 8.23: persist, commit, then publish); a rollback drops them.
 * Writes outside a transaction are announced straight away. Announcing is best
 * effort and never fails the write that caused it.
 */
@Injectable()
export class OrderRealtimeSubscriber implements EntitySubscriberInterface, OnModuleInit {
  private readonly logger = new Logger(OrderRealtimeSubscriber.name);
  private readonly pending = new WeakMap<QueryRunner, Set<string>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: MessagingGateway,
  ) {}

  onModuleInit(): void {
    if (!this.dataSource.subscribers.includes(this)) this.dataSource.subscribers.push(this);
  }

  afterInsert(event: InsertEvent<Record<string, unknown>>): void {
    this.collect(event.queryRunner, event.metadata?.tableName, event.entity);
  }

  afterUpdate(event: UpdateEvent<Record<string, unknown>>): void {
    this.collect(event.queryRunner, event.metadata?.tableName, event.entity ?? event.databaseEntity);
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    // A nested commit only releases a savepoint; wait for the real one.
    if (event.queryRunner.isTransactionActive) return;
    const ids = this.pending.get(event.queryRunner);
    this.pending.delete(event.queryRunner);
    if (ids?.size) void this.publish([...ids]);
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    if (!event.queryRunner.isTransactionActive) this.pending.delete(event.queryRunner);
  }

  /** Announce these orders to the customer and the technician holding them, and refresh their threads. */
  async publish(serviceOrderIds: string[]): Promise<void> {
    if (!serviceOrderIds.length || !this.gateway.server) return;
    try {
      const orders: Array<{ id: string; status: string; booking_id: string; customer_id: string; technician_ids: string[] | null }> =
        await this.dataSource.query(
          `SELECT so.id, so.status::text AS status, so.booking_id, b.customer_id,
                  array_remove(array_agg(DISTINCT ta.technician_id), NULL) AS technician_ids
             FROM service_orders so
             JOIN bookings b ON b.id = so.booking_id
             -- A technician replaced on the order no longer follows it.
             LEFT JOIN technician_assignments ta ON ta.service_order_id = so.id AND ta.is_active = true
            WHERE so.id = ANY($1::uuid[])
            GROUP BY so.id, b.customer_id`,
          [serviceOrderIds],
        );
      for (const order of orders) {
        this.gateway.emitOrderUpdated([order.customer_id, ...(order.technician_ids ?? [])], {
          serviceOrderId: order.id,
          bookingId: order.booking_id,
          status: order.status,
        });
      }
      // Whether the chat is open follows the order (closed once completed, open
      // again during a warranty claim), so the threads of these orders refresh too.
      const threads: Array<{ id: string; customer_id: string; technician_id: string }> = await this.dataSource.query(
        `SELECT id, customer_id, technician_id FROM conversations WHERE service_order_id = ANY($1::uuid[])`,
        [serviceOrderIds],
      );
      for (const thread of threads) this.gateway.emitConversationTouched([thread.customer_id, thread.technician_id], thread.id);
    } catch (error) {
      this.logger.warn(`Order update not announced: ${(error as Error).message}`);
    }
  }

  private collect(queryRunner: QueryRunner | undefined, table: string | undefined, entity: Record<string, unknown> | undefined): void {
    if (!table || !ORDER_TABLES.has(table) || !entity) return;
    const id = table === 'service_orders' ? entity.id : entity.serviceOrderId;
    if (typeof id !== 'string' || !id) return;
    if (queryRunner?.isTransactionActive) {
      const ids = this.pending.get(queryRunner) ?? new Set<string>();
      ids.add(id);
      this.pending.set(queryRunner, ids);
    } else {
      void this.publish([id]);
    }
  }
}

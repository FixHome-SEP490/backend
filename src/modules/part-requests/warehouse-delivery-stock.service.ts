import { EntityManager } from 'typeorm';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities';
import { PartRequest, PartRequestItem } from './entities';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import {
  canonicalWarehouseQuantities,
  warehouseBalance,
} from './warehouse-fulfillment.rules';
import { isDeepStrictEqual } from 'node:util';
import { advanceDelivery } from './warehouse-delivery.policy';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';

/** Dormant internal stock writer. Consumes a persisted command, NEVER caller quantities/verdicts.
 * Two independent DB gates currently make admitted physical events impossible. Future activation
 * must replace event admission, integrate lifecycle release + custody and verify approvals FIRST.
 * Caller owns transaction; any error MUST roll it back. No public/Nest registration. */
export class WarehouseDeliveryStock {
  async applyRecordedEvent(
    manager: EntityManager,
    requestId: string,
    commandId: string,
  ) {
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('DELIVERY_TRANSACTION_REQUIRED');
    const [gate] = await manager.query(
      'SELECT enabled FROM warehouse_delivery_gate WHERE id=1 FOR SHARE',
    );
    if (gate?.enabled !== true) {
      // A forward-reviewed, zero-fee proposal admits only its own cohort. The old
      // global gate remains immutable/closed; Admin drafts cannot open it.
      const [admission] = await manager.query(
        `SELECT true AS admitted FROM delivery_shipping_proposals p
        JOIN delivery_consent_sessions s ON s.part_request_id=p.part_request_id AND s.quote_version=p.quote_version
        WHERE p.part_request_id=$1 AND s.invalidated_at IS NULL AND s.status='ACTUAL_RECORDED'
        AND (s.projection#>>'{quote,totalShippingFee}')::numeric=0
        AND (s.projection#>>'{actual,totalShippingFee}')::numeric=0
        AND s.projection->'customerConsent'<>'null'::jsonb AND s.projection->'technicianConsent'<>'null'::jsonb
        UNION ALL SELECT true AS admitted FROM warehouse_delivery_events e JOIN delivery_shipping_proposals p ON p.part_request_id=e.part_request_id
        WHERE e.part_request_id=$1 AND e.command_id=$2 AND e.kind='RELEASE' LIMIT 1`,
        [requestId, commandId],
      );
      if (admission?.admitted !== true)
        throw new Error('DELIVERY_PHYSICAL_ACTIVATION_CLOSED');
    }
    const ref = await manager.findOneOrFail(PartRequest, {
      where: { id: requestId },
    });
    const order = await manager.findOneOrFail(ServiceOrder, {
      where: { id: ref.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    const tech = await manager.findOneOrFail(User, {
      where: { id: ref.technicianId },
      lock: { mode: 'pessimistic_write' },
    });
    const request = await manager.findOneOrFail(PartRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      request.serviceOrderId !== ref.serviceOrderId ||
      request.technicianId !== ref.technicianId ||
      request.fulfillmentMethod !== 'delivery'
    )
      throw new Error('DELIVERY_SCOPE_CHANGED');
    await manager.query(
      'SELECT part_request_id FROM warehouse_delivery_cohorts WHERE part_request_id=$1 FOR UPDATE',
      [requestId],
    );
    const event = await manager.findOneOrFail(WarehouseDeliveryEvent, {
      where: { partRequestId: requestId, commandId },
    });
    if (
      event.kind !== 'RELEASE' &&
      (tech.role !== 'technician' ||
        !tech.isActive ||
        tech.status !== 'active' ||
        !['accepted', 'en_route', 'under_repair'].includes(order.status) ||
        order.completionRequestedAt ||
        !(await manager.findOne(TechnicianAssignment, {
          where: {
            serviceOrderId: order.id,
            technicianId: tech.id,
            isActive: true,
          },
          lock: { mode: 'pessimistic_read' },
        })) ||
        (await manager.findOne(Invoice, {
          where: { serviceOrderId: order.id },
        })))
    )
      throw new Error('DELIVERY_SCOPE_FROZEN');
    if (
      event.kind === 'RESERVE' &&
      (event.actorRole !== 'technician' ||
        event.actorUserId !== request.technicianId)
    )
      throw new Error('DELIVERY_ACTOR_DENIED');
    const state = event.snapshot;
    if (
      !['RESERVE', 'RELEASE', 'ISSUE_TO_COURIER'].includes(event.kind) ||
      !state.warehouseId ||
      !state.responsibleUserId ||
      event.resultVersion !== state.version ||
      !state.quantities.length
    )
      throw new Error('DELIVERY_STOCK_EVENT_INVALID');
    const preceding = event.expectedVersion
      ? await manager.findOne(WarehouseDeliveryEvent, {
          where: {
            partRequestId: requestId,
            resultVersion: event.expectedVersion,
          },
        })
      : null;
    if (event.kind === 'RESERVE') {
      if (
        state.status !== 'RESERVED' ||
        state.courierReference !== null ||
        state.evidence.length ||
        (event.expectedVersion > 0 &&
          (!preceding ||
            !['INELIGIBLE', 'PENDING_ASSISTANCE', 'RELEASED'].includes(
              preceding.snapshot.status,
            )))
      )
        throw new Error('DELIVERY_STOCK_CHAIN_INVALID');
    } else {
      const proof = state.evidence.at(-1);
      const metadata = proof
        ? {
            courierReference: proof.courierReference,
            evidenceRef: proof.evidenceRef,
            contentDigest: proof.contentDigest,
          }
        : null;
      if (
        !preceding ||
        !isDeepStrictEqual(
          advanceDelivery(
            preceding.snapshot,
            event.kind as 'RELEASE' | 'ISSUE_TO_COURIER',
            event.kind === 'RELEASE' ? null : metadata,
          ),
          state,
        )
      )
        throw new Error('DELIVERY_STOCK_CHAIN_INVALID');
    }
    const items = await manager.find(PartRequestItem, {
      where: { partRequestId: requestId },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_read' },
    });
    const required = canonicalWarehouseQuantities(items);
    if (!isDeepStrictEqual(required, state.quantities))
      throw new Error('DELIVERY_QUANTITIES_CHANGED');
    const warehouse = await manager.findOneOrFail(Warehouse, {
      where: { id: state.warehouseId },
      lock: { mode: 'pessimistic_read' },
    });
    const sm = await manager.findOne(User, {
      where: {
        id:
          event.kind === 'RELEASE'
            ? warehouse.responsibleUserId
            : state.responsibleUserId,
      },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      (event.kind !== 'RELEASE' &&
        (warehouse.status !== 'active' ||
          warehouse.responsibleUserId !== state.responsibleUserId)) ||
      sm?.role !== 'service_manager' ||
      !sm.isActive ||
      sm.status !== 'active' ||
      (event.kind === 'RELEASE' &&
        (event.actorRole !== 'service_manager' ||
          event.actorUserId !== sm.id)) ||
      (event.kind === 'ISSUE_TO_COURIER' &&
        (event.actorUserId !== sm.id ||
          event.actorRole !== 'service_manager' ||
          state.status !== 'ISSUED_TO_COURIER' ||
          !state.evidence.some((e) => e.kind === 'ISSUE_TO_COURIER')))
    )
      throw new Error('DELIVERY_WAREHOUSE_DENIED');
    // Every command is whole-request and has one warehouse. Lock ALL SKUs before any write.
    const stocks = await manager.query(
      `SELECT part_id AS "partId",on_hand AS "onHand",reserved FROM warehouse_stock
      WHERE warehouse_id=$1 AND part_id=ANY($2::uuid[]) ORDER BY part_id FOR UPDATE`,
      [state.warehouseId, required.map((q) => q.partId)],
    );
    const previous = await manager.query(
      'SELECT part_id FROM warehouse_delivery_movements WHERE part_request_id=$1 AND command_id=$2 ORDER BY part_id',
      [requestId, commandId],
    );
    if (previous.length) {
      if (
        !isDeepStrictEqual(
          previous.map((r: { part_id: string }) => r.part_id),
          required.map((q) => q.partId),
        )
      )
        throw new Error('DELIVERY_PARTIAL_JOURNAL');
      return { replayed: true };
    }
    const attributable = await manager.query(
      `SELECT part_id AS "partId",sum(reservation_delta)::int AS reserved,
      bool_or(kind='ISSUE_TO_COURIER') AS issued FROM warehouse_delivery_movements
      WHERE part_request_id=$1 GROUP BY part_id ORDER BY part_id`,
      [requestId],
    );
    for (const item of required) {
      const own = attributable.find(
        (r: { partId: string }) => r.partId === item.partId,
      );
      if (
        own?.issued ||
        (own?.reserved ?? 0) !== (event.kind === 'RESERVE' ? 0 : item.quantity)
      )
        throw new Error('DELIVERY_RESERVATION_PROOF_REQUIRED');
    }
    if (
      attributable.some(
        (r: { partId: string }) => !required.some((q) => q.partId === r.partId),
      )
    )
      throw new Error('DELIVERY_QUANTITIES_CHANGED');
    const balances = required.map((item) => {
      const stock = stocks.find(
        (s: { partId: string }) => s.partId === item.partId,
      );
      if (!stock) throw new Error('DELIVERY_STOCK_MISSING');
      const delta = event.kind === 'ISSUE_TO_COURIER' ? -item.quantity : 0;
      const reservationDelta =
        event.kind === 'RESERVE' ? item.quantity : -item.quantity;
      return {
        item,
        delta,
        reservationDelta,
        ...warehouseBalance(
          stock.onHand,
          stock.reserved,
          delta,
          reservationDelta,
        ),
      };
    });
    for (const b of balances) {
      // Forward migration owns current+delta validation and the stock UPDATE inside
      // the movement INSERT trigger. A receipt can never exist without its delta.
      await manager.query(
        `INSERT INTO warehouse_delivery_movements(part_request_id,command_id,warehouse_id,part_id,kind,delta,reservation_delta,on_hand_after,reserved_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          requestId,
          commandId,
          state.warehouseId,
          b.item.partId,
          event.kind,
          b.delta,
          b.reservationDelta,
          b.onHand,
          b.reserved,
        ],
      );
    }
    return { replayed: false };
  }
}

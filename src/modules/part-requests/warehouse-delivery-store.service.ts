import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Role } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { QuotationItem } from '../quotations/entities/quotation-item.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { canonicalWarehouseQuantities } from './warehouse-fulfillment.rules';
import { isDeepStrictEqual } from 'node:util';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { PartRequest, PartRequestItem } from './entities';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import {
  assessDeliveryStock,
  CourierMetadata,
  DeliveryPhysicalState,
  PhysicalCommandKind,
} from './warehouse-delivery.policy';

export type DeliveryPhysicalCommand = {
  commandId: string;
  expectedVersion: number;
  kind: PhysicalCommandKind;
  evidence?: CourierMetadata;
};
const fail = (code: string): never => {
  throw new Error(`WAREHOUSE_DELIVERY_${code}`);
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Stored rows (users, orders, warehouses) may hold any UUID version: seed accounts are not v4.
const entityId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Internal only, NOT a Nest provider. Caller authenticates actor and owns transaction/rollback.
 * No HTTP adapter can enroll/execute this store. Lock order matches W2: Order -> Technician
 * -> Request -> Cohort -> event stream -> Warehouse/SM -> ordered Stock. No money/QR writes.
 * ASSESS via RESERVE can persist blocked decisions; all physical commands remain CLOSED. */
export class WarehouseDeliveryStore {
  private transaction(manager: EntityManager) {
    if (!manager.queryRunner?.isTransactionActive) fail('TRANSACTION_REQUIRED');
  }

  private async scope(
    manager: EntityManager,
    id: string,
    actor: { id: string; role: string },
  ) {
    this.transaction(manager);
    if (actor.role !== Role.TECHNICIAN || !entityId.test(actor.id))
      fail('ACTOR_DENIED');
    const reference = await manager.findOne(PartRequest, { where: { id } });
    if (!reference || reference.technicianId !== actor.id)
      return fail('ACTOR_DENIED');
    const order = await manager.findOne(ServiceOrder, {
      where: { id: reference.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    const technician = await manager.findOne(User, {
      where: { id: reference.technicianId },
      lock: { mode: 'pessimistic_write' },
    });
    const request = await manager.findOne(PartRequest, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !technician ||
      technician.role !== Role.TECHNICIAN ||
      !technician.isActive ||
      technician.status !== 'active'
    )
      return fail('ACTOR_DENIED');
    if (
      !order ||
      !request ||
      request.serviceOrderId !== order.id ||
      request.technicianId !== reference.technicianId
    )
      return fail('SCOPE_CHANGED');
    const assignment = await manager.findOne(TechnicianAssignment, {
      where: {
        serviceOrderId: order.id,
        technicianId: request.technicianId,
        isActive: true,
      },
      lock: { mode: 'pessimistic_read' },
    });
    if (!assignment) return fail('ACTOR_DENIED');
    return { request, order };
  }

  /** Future intake must call this in the SAME transaction that INSERTed the request.
   * DB checks current transaction xmin + server creation time, not a client 'new' flag.
   * Existing legacy creation paths deliberately DO NOT call it; no automatic backfill. */
  async enrollNew(
    manager: EntityManager,
    id: string,
    actor: { id: string; role: string },
  ) {
    const { request } = await this.scope(manager, id, actor);
    if (
      request.fulfillmentMethod !== 'delivery' ||
      request.status !== 'requested' ||
      !['quotation', 'additional'].includes(request.requestType)
    )
      fail('INELIGIBLE');
    await manager.query(
      `INSERT INTO warehouse_delivery_cohorts(part_request_id,service_order_id,technician_id)
      VALUES($1,$2,$3)`,
      [id, request.serviceOrderId, request.technicianId],
    );
  }

  async execute(
    manager: EntityManager,
    id: string,
    command: DeliveryPhysicalCommand,
    actor: { id: string; role: string },
  ) {
    this.transaction(manager);
    if (
      !entityId.test(id) ||
      !command ||
      Object.keys(command).some(
        (k) =>
          !['commandId', 'expectedVersion', 'kind', 'evidence'].includes(k),
      ) ||
      !uuid.test(command.commandId) ||
      !Number.isInteger(command.expectedVersion) ||
      command.expectedVersion < 0 ||
      command.expectedVersion >= 2147483647 ||
      ![
        'RESERVE',
        'RELEASE',
        'ISSUE_TO_COURIER',
        'COURIER_DISPATCH',
        'TECHNICIAN_RECEIPT',
      ].includes(command.kind) ||
      (command.kind === 'RESERVE' &&
        Object.prototype.hasOwnProperty.call(command, 'evidence'))
    )
      fail('COMMAND_INVALID');
    // No missing approval is replaced by client metadata, B1 status, Admin Draft or W2 QR.
    if (command.kind !== 'RESERVE') return fail('PHYSICAL_ACTIVATION_CLOSED');
    const { request, order } = await this.scope(manager, id, actor);
    const [cohort] = await manager.query(
      'SELECT * FROM warehouse_delivery_cohorts WHERE part_request_id=$1 FOR UPDATE',
      [id],
    );
    if (!cohort) return fail('LEGACY_REQUEST');
    if (
      cohort.service_order_id !== order.id ||
      cohort.technician_id !== actor.id
    )
      return fail('SCOPE_CHANGED');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          id,
          actorId: actor.id,
          role: actor.role,
          commandId: command.commandId,
          expectedVersion: command.expectedVersion,
          kind: command.kind,
        }),
      )
      .digest('hex');
    const prior = await manager.findOne(WarehouseDeliveryEvent, {
      where: { partRequestId: id, commandId: command.commandId },
    });
    if (prior) {
      if (prior.fingerprint !== fingerprint) return fail('COMMAND_CONFLICT');
      // Return immutable ORIGINAL receipt, never rewind or return a later decision as its result.
      return { state: prior.snapshot, replayed: true };
    }
    const head = await manager.findOne(WarehouseDeliveryEvent, {
      where: { partRequestId: id },
      order: { resultVersion: 'DESC' },
    });
    if ((head?.resultVersion ?? 0) !== command.expectedVersion)
      return fail('CAS_CONFLICT');
    const source =
      request.requestType === 'quotation' &&
      request.quotationId &&
      !request.additionalCostId
        ? await manager.findOne(Quotation, {
            where: { id: request.quotationId },
            lock: { mode: 'pessimistic_read' },
          })
        : request.requestType === 'additional' &&
            request.additionalCostId &&
            !request.quotationId
          ? await manager.findOne(AdditionalCostRequest, {
              where: { id: request.additionalCostId },
              lock: { mode: 'pessimistic_read' },
            })
          : null;
    const items = await manager.find(PartRequestItem, {
      where: { partRequestId: id },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_read' },
    });
    const booking = await manager.findOne(Booking, {
      where: { id: order.bookingId },
    });
    const sourceItems =
      source && request.requestType === 'quotation'
        ? await manager.find(QuotationItem, {
            where: { quotationId: source.id },
            order: { id: 'ASC' },
            lock: { mode: 'pessimistic_read' },
          })
        : source
          ? await manager.find(AdditionalCostItem, {
              where: { requestId: source.id },
              order: { id: 'ASC' },
              lock: { mode: 'pessimistic_read' },
            })
          : [];
    let quantitiesMatch = false;
    try {
      quantitiesMatch = isDeepStrictEqual(
        canonicalWarehouseQuantities(items),
        canonicalWarehouseQuantities(
          sourceItems
            .filter(
              (i) => i.type === 'parts_equipment' && i.partSource === 'fixhome',
            )
            .map((i) => ({
              partCatalogId: i.partCatalogId,
              partSource: i.partSource!,
              quantity: i.quantity,
            })),
        ),
      );
    } catch {
      /* Missing/malformed source stays unverified. Deficit/legacy bindings need separate admission. */
    }
    const approved =
      !!booking &&
      !!source &&
      source.status === 'approved' &&
      source.decidedAt instanceof Date &&
      Number.isFinite(source.decidedAt.getTime()) &&
      source.serviceOrderId === order.id &&
      source.technicianId === request.technicianId &&
      quantitiesMatch &&
      (request.requestType === 'quotation'
        ? Number.isInteger((source as Quotation).version) &&
          (source as Quotation).version > 0
        : (source as AdditionalCostRequest).decidedByCustomerId ===
          booking.customerId);
    const assessment = assessDeliveryStock({
      fresh: true,
      delivery: request.fulfillmentMethod === 'delivery',
      approved,
      open:
        ['accepted', 'en_route', 'under_repair'].includes(order.status) &&
        !order.completionRequestedAt &&
        request.status === 'requested' &&
        !(await manager.findOne(Invoice, {
          where: { serviceOrderId: order.id },
        })),
      items,
      warehouses: [],
      stocks: [],
      // There is currently NO approved shipping source or authenticated dual-consent mutation.
      // This is not configurable. Opening needs separate source integration + forward DDL review.
      shippingApproved: false,
      consentVerified: false,
    });
    const snapshot: DeliveryPhysicalState = {
      ...assessment,
      version: command.expectedVersion + 1,
      courierReference: null,
      evidence: [],
    };
    await manager.insert(WarehouseDeliveryEvent, {
      partRequestId: id,
      commandId: command.commandId,
      actorUserId: actor.id,
      actorRole: actor.role,
      kind: command.kind,
      expectedVersion: command.expectedVersion,
      resultVersion: snapshot.version,
      fingerprint,
      snapshot,
    });
    return { state: snapshot, replayed: false };
  }
}

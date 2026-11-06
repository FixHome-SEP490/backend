import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../../shared/enums';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { Booking } from '../bookings/entities/booking.entity';
import {
  OrderEvidenceStorage,
  EvidenceFile,
} from '../media/order-evidence-storage.service';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { AdditionalCostItem } from '../service-orders/entities/additional-cost-item.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { PartRequest, PartRequestItem } from './entities';
import { DeliveryOperationEvidence } from './entities/delivery-operation-evidence.entity';
import { DeliveryShippingProposal } from './entities/delivery-shipping-proposal.entity';
import { WarehouseDeliveryEvent } from './entities/warehouse-delivery-event.entity';
import { DeliveryConsentStoreService } from './delivery-consent-store.service';
import { DeliveryActor, DeliveryConsentState } from './delivery-consent.policy';
import {
  advanceDelivery,
  assessDeliveryStock,
  DeliveryPhysicalState,
  PhysicalCommandKind,
} from './warehouse-delivery.policy';
import { canonicalWarehouseQuantities } from './warehouse-fulfillment.rules';
import { WarehouseDeliveryStock } from './warehouse-delivery-stock.service';

type Actor = { id: string; role: string };
type Identity = { commandId: string; expectedVersion: number };
export type ShippingProposalInput = Identity & {
  warehouseId: string;
  evidenceId: string;
  courierReference: string;
  totalShippingFee: number;
};
export type ShippingConsentInput = Identity & {
  quoteVersion: number;
  quoteFingerprint: string;
  totalShippingFee: number;
  shippingShare: number;
  accepted: true;
};
export type DeliveryPhysicalInput = Identity & { evidenceId?: string };
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const explicitDatabaseZero = (value: unknown) => value === 0 || value === '0';
const conflict = (blocker: string): never => {
  throw new BusinessException(
    ErrorCodes.CONFLICT,
    'Yêu cầu chưa đủ điều kiện thực hiện. Vui lòng kiểm tra lại.',
    { blocker },
  );
};
const denied = (): never => {
  throw new NotFoundException('Không tìm thấy yêu cầu.');
};
const publicQuote = (state: DeliveryConsentState | null) =>
  state
    ? {
        quoteVersion: state.quote.quoteVersion,
        fingerprint: state.quote.fingerprint,
        policyVersion: state.quote.policyVersion,
        totalShippingFee: state.quote.totalShippingFee,
        customerShippingShare: state.quote.customerShippingShare,
        technicianShippingShare: state.quote.technicianShippingShare,
        laborBudget: 'UNVERIFIED' as const,
      }
    : null;

/** Authenticated zero-fee operations; positive spending requires a Finance-approved ledger. */
@Injectable()
export class DeliveryOperationsService {
  private readonly consents = new DeliveryConsentStoreService();
  private readonly stock = new WarehouseDeliveryStock();
  constructor(
    private readonly db: DataSource,
    private readonly storage: OrderEvidenceStorage,
  ) {}

  private input(value: object, keys: string[]) {
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length ||
      Object.keys(value).length !== keys.length ||
      keys.some((k) => !Object.prototype.hasOwnProperty.call(value, k))
    )
      throw new BadRequestException('Dữ liệu yêu cầu không hợp lệ.');
  }
  private identity(body: Identity) {
    if (
      !uuid.test(body.commandId) ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 0 ||
      body.expectedVersion >= 2147483647
    )
      throw new BadRequestException('Mã lệnh hoặc phiên bản không hợp lệ.');
  }
  private async scope(
    m: EntityManager,
    id: string,
    actor: Actor,
    warehouseId?: string,
  ) {
    if (
      !uuid.test(id) ||
      !uuid.test(actor.id) ||
      ![Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER].includes(
        actor.role as Role,
      )
    )
      denied();
    const user = await m.findOne(User, { where: { id: actor.id } });
    if (
      !user ||
      user.role !== actor.role ||
      !user.isActive ||
      user.status !== 'active'
    )
      denied();
    const ref = await m.findOne(PartRequest, { where: { id } });
    if (!ref) return denied();
    const order = await m.findOne(ServiceOrder, {
      where: { id: ref.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    await m.findOne(User, {
      where: { id: ref.technicianId },
      lock: { mode: 'pessimistic_write' },
    });
    const request = await m.findOne(PartRequest, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !order ||
      !request ||
      request.serviceOrderId !== order.id ||
      request.technicianId !== ref.technicianId
    )
      return denied();
    const booking = await m.findOne(Booking, {
      where: { id: order.bookingId },
      lock: { mode: 'pessimistic_read' },
    });
    const assignment = await m.findOne(TechnicianAssignment, {
      where: {
        serviceOrderId: order.id,
        technicianId: request.technicianId,
        isActive: true,
      },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !booking ||
      !assignment ||
      (actor.role === Role.CUSTOMER && actor.id !== booking.customerId) ||
      (actor.role === Role.TECHNICIAN && actor.id !== request.technicianId)
    )
      return denied();
    const currentUser = await m.findOne(User, {
      where: { id: actor.id },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !currentUser ||
      currentUser.role !== actor.role ||
      !currentUser.isActive ||
      currentUser.status !== 'active'
    )
      return denied();
    const [cohort] = await m.query(
      'SELECT * FROM warehouse_delivery_cohorts WHERE part_request_id=$1 FOR UPDATE',
      [id],
    );
    if (
      !cohort ||
      cohort.service_order_id !== order.id ||
      cohort.technician_id !== request.technicianId
    )
      return denied();
    const proposal = await m.findOne(DeliveryShippingProposal, {
      where: { partRequestId: id },
      order: { quoteVersion: 'DESC' },
    });
    const warehouse =
      warehouseId || proposal?.warehouseId
        ? await m.findOne(Warehouse, {
            where: { id: warehouseId ?? proposal!.warehouseId },
            lock: { mode: 'pessimistic_read' },
          })
        : null;
    if (
      actor.role === Role.SERVICE_MANAGER &&
      (!warehouse || warehouse.responsibleUserId !== actor.id)
    )
      return denied();
    return { request, order, booking, assignment, proposal, warehouse };
  }
  private async source(
    m: EntityManager,
    s: Awaited<ReturnType<DeliveryOperationsService['scope']>>,
  ) {
    const { request, order, booking } = s;
    if (
      request.requestType !== 'additional' ||
      request.fulfillmentMethod !== 'delivery' ||
      !request.additionalCostId ||
      request.quotationId
    )
      return conflict('DELIVERY_APPROVED_SHIPPING_SOURCE_REQUIRED');
    const cost = await m.findOne(AdditionalCostRequest, {
      where: { id: request.additionalCostId },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !cost ||
      cost.status !== 'approved' ||
      !cost.decidedAt ||
      cost.serviceOrderId !== order.id ||
      cost.technicianId !== request.technicianId ||
      cost.decidedByCustomerId !== booking.customerId ||
      cost.fulfillmentMethod !== 'delivery'
    )
      return conflict('DELIVERY_APPROVED_SHIPPING_SOURCE_REQUIRED');
    const items = await m.find(PartRequestItem, {
      where: { partRequestId: request.id },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_read' },
    });
    const sourceItems = await m.find(AdditionalCostItem, {
      where: { requestId: cost.id },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_read' },
    });
    let quantities: ReturnType<typeof canonicalWarehouseQuantities>;
    try {
      quantities = canonicalWarehouseQuantities(items);
      const approved = canonicalWarehouseQuantities(
        sourceItems
          .filter(
            (i) => i.type === 'parts_equipment' && i.partSource === 'fixhome',
          )
          .map((i) => ({
            partCatalogId: i.partCatalogId,
            partSource: i.partSource!,
            quantity: i.quantity,
          })),
      );
      if (!isDeepStrictEqual(quantities, approved))
        return conflict('DELIVERY_WHOLE_SOURCE_REQUIRED');
    } catch {
      return conflict('DELIVERY_WHOLE_SOURCE_REQUIRED');
    }
    // No canonical all-delivery coverage/current heads or approved L/C/D ledger exists here.
    // A local quote's netLaborAfterShipping (or the pure aggregate assessment) cannot authorize
    // spending. Future consumption of assessDeliveryOrderShippingLaborBudget must read those
    // sources under the ServiceOrder lock above and retain CAS + the independent Finance gate.
    // ZERO spending only: never claim that siblings, labor or deductions are zero.
    if (
      !explicitDatabaseZero(cost.shippingFee) ||
      !explicitDatabaseZero(request.shippingFee)
    )
      return conflict('FINANCE_LEDGER_SOURCE_REQUIRED');
    const contextDigest = hash({
      cost,
      items,
      sourceItems,
      assignmentId: s.assignment.id,
      customerId: booking.customerId,
    });
    return { cost, items, quantities, contextDigest };
  }
  private async open(
    m: EntityManager,
    s: Awaited<ReturnType<DeliveryOperationsService['scope']>>,
  ) {
    if (
      !['accepted', 'en_route', 'under_repair'].includes(s.order.status) ||
      s.order.completionRequestedAt ||
      s.request.status !== 'requested' ||
      (await m.findOne(Invoice, { where: { serviceOrderId: s.order.id } }))
    )
      conflict('DELIVERY_SCOPE_FROZEN');
  }
  private async bound(
    m: EntityManager,
    s: Awaited<ReturnType<DeliveryOperationsService['scope']>>,
    state: DeliveryConsentState | null,
  ) {
    const facts = await this.source(m, s);
    const p = s.proposal;
    if (
      !p ||
      !state ||
      p.quoteVersion !== state.quote.quoteVersion ||
      p.assignmentId !== s.assignment.id ||
      p.contextDigest !== facts.contextDigest ||
      !s.warehouse ||
      s.warehouse.status !== 'active' ||
      s.warehouse.responsibleUserId !== p.responsibleUserId
    )
      return conflict('DELIVERY_PROPOSAL_INVALIDATED');
    const sm = await m.findOne(User, {
      where: { id: p.responsibleUserId },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !sm ||
      sm.role !== Role.SERVICE_MANAGER ||
      !sm.isActive ||
      sm.status !== 'active'
    )
      conflict('DELIVERY_PROPOSAL_INVALIDATED');
    for (const [id, role] of [
      [s.request.technicianId, Role.TECHNICIAN],
      [s.booking.customerId, Role.CUSTOMER],
    ]) {
      const user = await m.findOne(User, {
        where: { id },
        lock: { mode: 'pessimistic_read' },
      });
      if (
        !user ||
        user.role !== role ||
        !user.isActive ||
        user.status !== 'active'
      )
        conflict('DELIVERY_PROPOSAL_INVALIDATED');
    }
    return facts;
  }
  private async evidence(
    m: EntityManager,
    s: Awaited<ReturnType<DeliveryOperationsService['scope']>>,
    id: string,
    purpose: string,
    version: number,
    actor: Actor,
  ) {
    const e = await m.findOne(DeliveryOperationEvidence, { where: { id } });
    if (
      !e ||
      e.partRequestId !== s.request.id ||
      e.serviceOrderId !== s.order.id ||
      e.warehouseId !== s.warehouse?.id ||
      e.uploaderUserId !== actor.id ||
      e.purpose !== purpose ||
      e.quoteVersion !== version
    )
      return conflict('DELIVERY_EVIDENCE_REQUIRED');
    return e;
  }
  private async run<T>(fn: (m: EntityManager) => Promise<T>) {
    try {
      return await this.db.transaction(fn);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(DELIVERY_|WAREHOUSE_DELIVERY_)/.test(error.message)
      )
        conflict(error.message);
      throw error;
    }
  }
  async read(id: string, actor: Actor) {
    return this.run(async (m) => {
      const s = await this.scope(m, id, actor);
      const state = await this.consents.read(m, id);
      let invalidated = false;
      if (state) {
        try {
          await this.open(m, s);
          await this.bound(m, s, state);
        } catch (e) {
          if (!(e instanceof BusinessException) || e.getStatus() !== 409)
            throw e;
          invalidated = true;
        }
      }
      const physical = await m.findOne(WarehouseDeliveryEvent, {
        where: { partRequestId: id },
        order: { resultVersion: 'DESC' },
      });
      return {
        version: state?.version ?? 0,
        quote: publicQuote(state),
        invalidated,
        customerConsented: !!state?.customerConsent && !invalidated,
        technicianConsented: !!state?.technicianConsent && !invalidated,
        actual: state?.actual
          ? {
              totalShippingFee: state.actual.totalShippingFee,
              quoteVersion: state.actual.quoteVersion,
            }
          : null,
        physical: physical?.snapshot ?? null,
        financialExecution: 'BLOCKED',
        financialBlocker: 'FINANCE_LEDGER_SOURCE_REQUIRED',
      };
    });
  }
  async upload(
    id: string,
    warehouseId: string,
    purpose: string,
    quoteVersion: number,
    file: EvidenceFile,
    actor: Actor,
  ) {
    if (
      !uuid.test(warehouseId) ||
      ![
        'QUOTE',
        'ACTUAL',
        'ISSUE_TO_COURIER',
        'COURIER_DISPATCH',
        'TECHNICIAN_RECEIPT',
      ].includes(purpose) ||
      !Number.isInteger(quoteVersion) ||
      quoteVersion < 1 ||
      quoteVersion > 2147483647
    )
      throw new BadRequestException(
        'Loại bằng chứng hoặc phiên bản không hợp lệ.',
      );
    if (
      (purpose === 'TECHNICIAN_RECEIPT'
        ? Role.TECHNICIAN
        : Role.SERVICE_MANAGER) !== actor.role
    )
      return denied();
    this.storage.validate(file);
    const ref = await this.run(async (m) => {
      const s = await this.scope(m, id, actor, warehouseId);
      await this.open(m, s);
      return s.order.id;
    });
    const privateObjectRef = await this.storage.upload(ref, actor.id, file);
    try {
      return await this.run(async (m) => {
        const s = await this.scope(m, id, actor, warehouseId);
        await this.open(m, s);
        if (purpose !== 'QUOTE' && s.proposal?.warehouseId !== warehouseId)
          return conflict('DELIVERY_EVIDENCE_WAREHOUSE_MISMATCH');
        const row = {
          id: randomUUID(),
          partRequestId: id,
          serviceOrderId: s.order.id,
          uploaderUserId: actor.id,
          warehouseId,
          purpose,
          quoteVersion,
          privateObjectRef,
          contentDigest: createHash('sha256').update(file.buffer).digest('hex'),
          mimeType: file.mimetype,
          fileSize: file.size,
        };
        await m.insert(DeliveryOperationEvidence, row);
        return {
          evidenceId: row.id,
          purpose,
          quoteVersion,
          verification: 'UPLOADED_BYTES_NOT_COURIER_VERIFIED',
        };
      });
    } catch (e) {
      await this.storage.delete(privateObjectRef);
      throw e;
    }
  }
  async evidenceAccess(id: string, evidenceId: string, actor: Actor) {
    return this.run(async (m) => {
      const e = await m.findOne(DeliveryOperationEvidence, {
        where: { id: evidenceId, partRequestId: id },
      });
      if (!e) return denied();
      await this.scope(m, id, actor, e.warehouseId);
      return {
        url: await this.storage.signedUrl(e.privateObjectRef),
        verification: 'UPLOADED_BYTES_NOT_COURIER_VERIFIED',
      };
    });
  }
  async propose(id: string, body: ShippingProposalInput, actor: Actor) {
    this.input(body, [
      'commandId',
      'expectedVersion',
      'warehouseId',
      'evidenceId',
      'courierReference',
      'totalShippingFee',
    ]);
    this.identity(body);
    if (
      !uuid.test(body.warehouseId) ||
      !uuid.test(body.evidenceId) ||
      typeof body.courierReference !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(body.courierReference) ||
      !Number.isSafeInteger(body.totalShippingFee) ||
      body.totalShippingFee < 0
    )
      throw new BadRequestException('Thông tin phí giao không hợp lệ.');
    if (body.totalShippingFee !== 0)
      return conflict('FINANCE_LEDGER_SOURCE_REQUIRED');
    if (actor.role !== Role.SERVICE_MANAGER) return denied();
    return this.run(async (m) => {
      const s = await this.scope(m, id, actor, body.warehouseId);
      await this.open(m, s);
      const facts = await this.source(m, s);
      const head = await m.findOne(WarehouseDeliveryEvent, {
        where: { partRequestId: id },
        order: { resultVersion: 'DESC' },
      });
      const old = await this.consents.read(m, id);
      const prior = await m.findOne(DeliveryShippingProposal, {
        where: { partRequestId: id, commandId: body.commandId },
      });
      if (
        !prior &&
        head &&
        !['RELEASED', 'INELIGIBLE', 'PENDING_ASSISTANCE'].includes(
          head.snapshot.status,
        )
      )
        conflict('DELIVERY_RELEASE_REQUIRED');
      const quoteVersion =
        prior?.quoteVersion ?? (old ? old.quote.quoteVersion + 1 : 1);
      const e = await this.evidence(
        m,
        s,
        body.evidenceId,
        'QUOTE',
        quoteVersion,
        actor,
      );
      if (!s.warehouse || s.warehouse.status !== 'active')
        return conflict('DELIVERY_WAREHOUSE_UNAVAILABLE');
      if (
        prior &&
        (prior.warehouseId !== body.warehouseId ||
          prior.courierReference !== body.courierReference ||
          prior.evidenceId !== body.evidenceId ||
          prior.contextDigest !== facts.contextDigest)
      )
        conflict('DELIVERY_COMMAND_CONFLICT');
      await this.consents.appendEvidence(
        m,
        id,
        {
          id: e.id,
          purpose: 'QUOTE',
          quoteVersion,
          privateObjectRef: e.privateObjectRef,
          contentDigest: e.contentDigest,
          mimeType: e.mimeType,
          fileSize: e.fileSize,
          retainUntil: null,
        },
        actor as DeliveryActor,
      );
      const result = await this.consents.execute(
        m,
        id,
        {
          kind: body.expectedVersion === 0 ? 'PROPOSE' : 'REVISE',
          commandId: body.commandId,
          expectedVersion: body.expectedVersion,
          totalShippingFee: 0,
          budget: {
            laborTotal: 0,
            commissionAmount: 0,
            knownApprovedDeductions: 0,
          },
          approvedCostRef: `additional-cost:${facts.cost.id}`,
          evidenceRef: `delivery-evidence:${e.id}`,
        },
        actor as DeliveryActor,
      );
      if (!result.replayed)
        await m.insert(DeliveryShippingProposal, {
          partRequestId: id,
          quoteVersion,
          commandId: body.commandId,
          warehouseId: body.warehouseId,
          responsibleUserId: actor.id,
          assignmentId: s.assignment.id,
          contextDigest: facts.contextDigest,
          courierReference: body.courierReference,
          evidenceId: e.id,
        });
      return {
        version: result.state.version,
        quote: publicQuote(result.state),
        replayed: result.replayed,
        financialExecution: 'BLOCKED',
      };
    });
  }
  async consent(id: string, body: ShippingConsentInput, actor: Actor) {
    this.input(body, [
      'commandId',
      'expectedVersion',
      'quoteVersion',
      'quoteFingerprint',
      'totalShippingFee',
      'shippingShare',
      'accepted',
    ]);
    this.identity(body);
    if (![Role.CUSTOMER, Role.TECHNICIAN].includes(actor.role as Role))
      return denied();
    return this.run(async (m) => {
      const s = await this.scope(m, id, actor);
      await this.open(m, s);
      await this.bound(m, s, await this.consents.read(m, id));
      const r = await this.consents.execute(
        m,
        id,
        {
          ...body,
          kind: 'CONSENT',
          evidenceRef: `delivery-consent:${id}:${body.commandId}`,
        },
        actor as DeliveryActor,
      );
      return {
        version: r.state.version,
        quote: publicQuote(r.state),
        customerConsented: !!r.state.customerConsent,
        technicianConsented: !!r.state.technicianConsent,
        replayed: r.replayed,
        financialExecution: 'BLOCKED',
      };
    });
  }
  async actual(
    id: string,
    body: Identity & {
      quoteVersion: number;
      totalShippingFee: number;
      evidenceId: string;
    },
    actor: Actor,
  ) {
    this.input(body, [
      'commandId',
      'expectedVersion',
      'quoteVersion',
      'totalShippingFee',
      'evidenceId',
    ]);
    this.identity(body);
    if (body.totalShippingFee !== 0)
      return conflict('FINANCE_LEDGER_SOURCE_REQUIRED');
    if (actor.role !== Role.SERVICE_MANAGER) return denied();
    return this.run(async (m) => {
      const s = await this.scope(m, id, actor);
      await this.open(m, s);
      const state = await this.consents.read(m, id);
      await this.bound(m, s, state);
      const e = await this.evidence(
        m,
        s,
        body.evidenceId,
        'ACTUAL',
        body.quoteVersion,
        actor,
      );
      await this.consents.appendEvidence(
        m,
        id,
        {
          id: e.id,
          purpose: 'ACTUAL',
          quoteVersion: body.quoteVersion,
          privateObjectRef: e.privateObjectRef,
          contentDigest: e.contentDigest,
          mimeType: e.mimeType,
          fileSize: e.fileSize,
          retainUntil: null,
        },
        actor as DeliveryActor,
      );
      const r = await this.consents.execute(
        m,
        id,
        {
          kind: 'RECORD_ACTUAL',
          commandId: body.commandId,
          expectedVersion: body.expectedVersion,
          quoteVersion: body.quoteVersion,
          totalShippingFee: 0,
          evidenceRef: `delivery-evidence:${e.id}`,
        },
        actor as DeliveryActor,
      );
      return {
        version: r.state.version,
        replayed: r.replayed,
        financialExecution: 'BLOCKED',
      };
    });
  }
  async physical(
    id: string,
    kind: PhysicalCommandKind,
    body: DeliveryPhysicalInput,
    actor: Actor,
  ) {
    this.input(body, [
      'commandId',
      'expectedVersion',
      ...(['RESERVE', 'RELEASE'].includes(kind) ? [] : ['evidenceId']),
    ]);
    this.identity(body);
    if (
      ![
        'RESERVE',
        'RELEASE',
        'ISSUE_TO_COURIER',
        'COURIER_DISPATCH',
        'TECHNICIAN_RECEIPT',
      ].includes(kind)
    )
      throw new BadRequestException('Thao tác không hợp lệ.');
    if (
      (['RESERVE', 'TECHNICIAN_RECEIPT'].includes(kind)
        ? Role.TECHNICIAN
        : Role.SERVICE_MANAGER) !== actor.role
    )
      return denied();
    return this.run(async (m) => {
      const s = await this.scope(m, id, actor);
      const prior = await m.findOne(WarehouseDeliveryEvent, {
        where: { partRequestId: id, commandId: body.commandId },
      });
      const fingerprint = hash({
        id,
        kind,
        body: {
          commandId: body.commandId,
          expectedVersion: body.expectedVersion,
          evidenceId: body.evidenceId ?? null,
        },
        actor: { id: actor.id, role: actor.role },
      });
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          conflict('DELIVERY_COMMAND_CONFLICT');
        return { state: prior.snapshot, replayed: true };
      }
      const head = await m.findOne(WarehouseDeliveryEvent, {
        where: { partRequestId: id },
        order: { resultVersion: 'DESC' },
      });
      if ((head?.resultVersion ?? 0) !== body.expectedVersion)
        return conflict('DELIVERY_CAS_CONFLICT');
      let state: DeliveryPhysicalState;
      if (kind === 'RELEASE') {
        if (!head || s.warehouse?.id !== head.snapshot.warehouseId)
          return conflict('DELIVERY_RELEASE_FORBIDDEN');
        state = advanceDelivery(head.snapshot, kind, null);
      } else {
        await this.open(m, s);
        const consent = await this.consents.read(m, id);
        const facts = await this.bound(m, s, consent);
        if (
          !consent?.customerConsent ||
          !consent.technicianConsent ||
          !consent.actual ||
          consent.quote.totalShippingFee !== 0 ||
          consent.actual.totalShippingFee !== 0
        )
          return conflict('DELIVERY_DUAL_CONSENT_AND_ACTUAL_REQUIRED');
        if (kind === 'RESERVE') {
          if (
            head &&
            !['INELIGIBLE', 'PENDING_ASSISTANCE', 'RELEASED'].includes(
              head.snapshot.status,
            )
          )
            return conflict('DELIVERY_ALREADY_RESERVED');
          const stocks = await m.query(
            `SELECT warehouse_id AS "warehouseId",part_id AS "partId",on_hand AS "onHand",reserved FROM warehouse_stock
            WHERE warehouse_id=$1 AND part_id=ANY($2::uuid[]) ORDER BY part_id FOR UPDATE`,
            [s.proposal!.warehouseId, facts.quantities.map((q) => q.partId)],
          );
          state = {
            ...assessDeliveryStock({
              fresh: true,
              delivery: true,
              open: true,
              approved: true,
              shippingApproved: true,
              consentVerified: true,
              items: facts.items,
              warehouses: [s.warehouse!],
              stocks,
            }),
            version: body.expectedVersion + 1,
            courierReference: null,
            evidence: [],
          };
        } else {
          if (!head) return conflict('DELIVERY_RESERVATION_REQUIRED');
          const e = await this.evidence(
            m,
            s,
            body.evidenceId!,
            kind,
            consent.quote.quoteVersion,
            actor,
          );
          if (
            head.snapshot.evidence.some(
              (pr) => pr.contentDigest === e.contentDigest,
            )
          )
            return conflict('DELIVERY_DISTINCT_STAGE_EVIDENCE_REQUIRED');
          state = advanceDelivery(head.snapshot, kind, {
            courierReference: s.proposal!.courierReference,
            evidenceRef: `delivery-operation-evidence:${e.id}`,
            contentDigest: e.contentDigest,
          });
        }
      }
      await m.insert(WarehouseDeliveryEvent, {
        partRequestId: id,
        commandId: body.commandId,
        actorUserId: actor.id,
        actorRole: actor.role,
        kind,
        expectedVersion: body.expectedVersion,
        resultVersion: state.version,
        fingerprint,
        snapshot: state,
      });
      if (
        (kind === 'RESERVE' && state.status === 'RESERVED') ||
        kind === 'RELEASE' ||
        kind === 'ISSUE_TO_COURIER'
      )
        await this.stock.applyRecordedEvent(m, id, body.commandId);
      await m.insert(AuditLog, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: `DELIVERY_${kind}`,
        resourceType: 'part_request',
        resourceId: id,
        after: {
          commandId: body.commandId,
          version: state.version,
          status: state.status,
          verification: 'RECORDED_NOT_EXTERNALLY_VERIFIED',
        },
      });
      return { state, replayed: false };
    });
  }
}

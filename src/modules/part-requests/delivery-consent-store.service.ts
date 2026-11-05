import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { EntityManager, IsNull } from 'typeorm';
import { Role } from '../../shared/enums';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import {
  applyDeliveryCommand,
  createDeliveryProposal,
  DeliveryActor,
  DeliveryCommand,
  DeliveryConsentState,
  DeliveryScope,
} from './delivery-consent.policy';
import { DeliveryConsentCommandRecord } from './entities/delivery-consent-command.entity';
import {
  DeliveryConsentProjection,
  DeliveryConsentSession,
} from './entities/delivery-consent-session.entity';
import { DeliveryEvidenceRecord } from './entities/delivery-evidence-record.entity';
import { PartRequest } from './entities/part-request.entity';

const fail = (code: string): never => {
  throw new Error(`DELIVERY_STORE_${code}`);
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const projection = ({
  receipts: _receipts,
  ...state
}: DeliveryConsentState): DeliveryConsentProjection => state;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
type EvidenceMetadata = Pick<
  DeliveryEvidenceRecord,
  | 'id'
  | 'purpose'
  | 'quoteVersion'
  | 'privateObjectRef'
  | 'contentDigest'
  | 'mimeType'
  | 'fileSize'
  | 'retainUntil'
>;

/** INERT, unregistered internal adapter. Caller MUST authenticate/authorize actors and derive
 * the complete Finance budget; DB role rechecks do not authenticate a caller. Evidence metadata
 * does not prove uploaded bytes. Caller owns transaction + rollback (including deferred checks).
 * Lock order: Order -> Technician -> PartRequest -> Session. No private commits or money writes. */
export class DeliveryConsentStoreService {
  private transaction(manager: EntityManager): void {
    if (!manager.queryRunner?.isTransactionActive) fail('TRANSACTION_REQUIRED');
  }

  private async scope(
    manager: EntityManager,
    requestId: string,
    responsibleId: string,
  ) {
    this.transaction(manager);
    const ref = await manager.findOne(PartRequest, {
      where: { id: requestId },
    });
    if (!ref) return fail('SCOPE_MISSING');
    const order = await manager.findOne(ServiceOrder, {
      where: { id: ref.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    await manager.findOne(User, {
      where: { id: ref.technicianId },
      lock: { mode: 'pessimistic_write' },
    });
    const request = await manager.findOne(PartRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !order ||
      !request ||
      request.serviceOrderId !== ref.serviceOrderId ||
      request.technicianId !== ref.technicianId
    )
      return fail('SCOPE_CHANGED');
    const booking = await manager.findOne(Booking, {
      where: { id: order.bookingId },
    });
    const assignment = await manager.findOne(TechnicianAssignment, {
      where: {
        serviceOrderId: order.id,
        technicianId: request.technicianId,
        isActive: true,
      },
    });
    if (
      !booking ||
      !assignment ||
      request.fulfillmentMethod !== 'delivery' ||
      !['additional', 'quotation'].includes(request.requestType)
    )
      return fail('SCOPE_CHANGED');
    for (const [id, role] of [
      [booking.customerId, Role.CUSTOMER],
      [request.technicianId, Role.TECHNICIAN],
      [responsibleId, Role.SERVICE_MANAGER],
    ]) {
      if (
        !(await manager.findOne(User, {
          where: {
            id,
            role: role as Role,
            isActive: true,
            status: 'active' as User['status'],
          },
        }))
      )
        return fail('ACTOR_DENIED');
    }
    // B1 has no authoritative DELIVERY allocation model. W2 PICKUP records, including
    // issued/released records retaining warehouse/SM IDs, are never read or used as proof.
    // Binding requires a separately reviewed forward migration and DELIVERY-specific gate.
    const warehouseId = null;
    const scope: DeliveryScope = {
      partRequestId: requestId,
      serviceOrderId: order.id,
      customerId: booking.customerId,
      technicianId: request.technicianId,
      responsibleServiceManagerId: responsibleId,
    };
    return { request, order, scope, assignmentId: assignment.id, warehouseId };
  }

  private async source(
    manager: EntityManager,
    request: PartRequest,
    customerId: string,
  ) {
    if (!!request.additionalCostId === !!request.quotationId)
      return fail('SOURCE_REQUIRED');
    const quotation = request.quotationId
      ? await manager.findOne(Quotation, { where: { id: request.quotationId } })
      : null;
    const cost = request.additionalCostId
      ? await manager.findOne(AdditionalCostRequest, {
          where: { id: request.additionalCostId },
        })
      : null;
    const source = quotation ?? cost;
    if (
      !source ||
      source.status !== 'approved' ||
      !source.decidedAt ||
      source.serviceOrderId !== request.serviceOrderId ||
      source.technicianId !== request.technicianId ||
      (cost &&
        (cost.decidedByCustomerId !== customerId ||
          request.requestType !== 'additional')) ||
      (quotation && request.requestType !== 'quotation')
    )
      return fail('SOURCE_MISMATCH');
    // Existing approved parts/labor source, NOT a legal approval of W3 shipping.
    const snapshot = JSON.parse(JSON.stringify(source)) as Record<
      string,
      unknown
    >;
    return {
      snapshot,
      digest: digest(snapshot),
      version: quotation?.version ?? null,
      ref: quotation
        ? `quotation:${quotation.id}:${quotation.version}`
        : `additional-cost:${cost!.id}`,
    };
  }

  private async hydrate(
    manager: EntityManager,
    session: DeliveryConsentSession,
  ): Promise<DeliveryConsentState> {
    const records = await manager.find(DeliveryConsentCommandRecord, {
      where: { partRequestId: session.partRequestId },
      order: { resultVersion: 'ASC' },
    });
    let state: DeliveryConsentState | undefined;
    for (const record of records) {
      const actor = { id: record.actorUserId, role: record.actorRole };
      if (!state) {
        if (record.commandBody.kind !== 'PROPOSE')
          return fail('CORRUPT_HISTORY');
        state = createDeliveryProposal(
          session.projection.scope,
          record.commandBody,
          actor,
        );
      } else state = applyDeliveryCommand(state, record.commandBody, actor);
      const receipt = state.receipts.at(-1)!;
      if (
        state.version !== record.resultVersion ||
        record.commandId !== receipt.commandId ||
        record.contentFingerprint !== receipt.contentFingerprint ||
        !equal(projection(state), record.snapshot)
      )
        return fail('CORRUPT_HISTORY');
    }
    if (
      !state ||
      session.version !== state.version ||
      session.quoteVersion !== state.quote.quoteVersion ||
      session.status !== state.status ||
      !equal(session.projection, projection(state)) ||
      !equal(state.scope, {
        partRequestId: session.partRequestId,
        serviceOrderId: session.serviceOrderId,
        customerId: session.customerId,
        technicianId: session.technicianId,
        responsibleServiceManagerId: session.responsibleServiceManagerId,
      })
    )
      return fail('CORRUPT_HISTORY');
    return state;
  }

  async read(
    manager: EntityManager,
    requestId: string,
  ): Promise<DeliveryConsentState | null> {
    this.transaction(manager);
    // Historical read; a future B2 adapter MUST authorize it separately.
    const session = await manager.findOne(DeliveryConsentSession, {
      where: { partRequestId: requestId },
      lock: { mode: 'pessimistic_read' },
    });
    return session ? this.hydrate(manager, session) : null;
  }

  async execute(
    manager: EntityManager,
    requestId: string,
    command: DeliveryCommand,
    actor: DeliveryActor,
  ) {
    this.transaction(manager);
    const ref = await manager.findOne(DeliveryConsentSession, {
      where: { partRequestId: requestId },
    });
    const current = await this.scope(
      manager,
      requestId,
      ref?.responsibleServiceManagerId ?? actor.id,
    );
    const session = await manager.findOne(DeliveryConsentSession, {
      where: { partRequestId: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    const { scope, request, order, assignmentId, warehouseId } = current;
    if (
      session &&
      (session.invalidatedAt ||
        session.assignmentId !== assignmentId ||
        session.warehouseId !== warehouseId ||
        session.sourceQuotationId !== (request.quotationId ?? null) ||
        session.sourceAdditionalCostId !== (request.additionalCostId ?? null) ||
        !equal(session.projection.scope, scope))
    )
      return fail('SCOPE_CHANGED');
    if (
      !(await manager.findOne(User, {
        where: {
          id: actor.id,
          role: actor.role,
          isActive: true,
          status: 'active' as User['status'],
        },
      }))
    )
      return fail('ACTOR_DENIED');
    const source = await this.source(manager, request, scope.customerId);
    const state = session ? await this.hydrate(manager, session) : null;
    if (!state && command.kind !== 'PROPOSE')
      return fail('INITIAL_PROPOSAL_REQUIRED');
    const next = state
      ? applyDeliveryCommand(state, command, actor)
      : createDeliveryProposal(
          scope,
          command as Extract<DeliveryCommand, { kind: 'PROPOSE' | 'REVISE' }>,
          actor,
        );
    const receipt = next.receipts.find(
      (r) => r.commandId === command.commandId,
    )!;
    if (state && next.version === state.version)
      return { state: next, receipt, replayed: true };
    if (
      ['cancelled', 'completed', 'disputed', 'warranty_in_progress'].includes(
        order.status,
      ) ||
      order.completionRequestedAt ||
      ['cancelled', 'completed', 'received'].includes(request.status) ||
      (await manager.findOne(Invoice, { where: { serviceOrderId: order.id } }))
    )
      return fail('ORDER_FROZEN');
    const isProposal = command.kind === 'PROPOSE' || command.kind === 'REVISE';
    const journal = state
      ? await manager.find(DeliveryConsentCommandRecord, {
          where: { partRequestId: requestId },
          order: { resultVersion: 'ASC' },
        })
      : [];
    const parent = journal.find(
      (r) =>
        r.quoteVersion === state?.quote.quoteVersion &&
        (r.kind === 'PROPOSE' || r.kind === 'REVISE'),
    );
    if (
      isProposal
        ? command.approvedCostRef !== source.ref
        : !parent ||
          parent.sourceDigest !== source.digest ||
          parent.sourceVersion !== source.version
    )
      return fail('SOURCE_CHANGED');
    let evidenceId: string | null = null;
    if (command.kind === 'CONSENT') {
      if (
        command.evidenceRef !==
        `delivery-consent:${requestId}:${command.commandId}`
      )
        return fail('EVIDENCE_MISMATCH');
    } else {
      evidenceId = command.evidenceRef.startsWith('delivery-evidence:')
        ? command.evidenceRef.slice('delivery-evidence:'.length)
        : null;
      if (!evidenceId || !uuid.test(evidenceId))
        return fail('EVIDENCE_REQUIRED');
      const evidence = await manager.findOne(DeliveryEvidenceRecord, {
        where: { id: evidenceId, partRequestId: requestId },
      });
      if (
        !evidence ||
        evidence.serviceOrderId !== order.id ||
        evidence.uploaderUserId !== scope.responsibleServiceManagerId ||
        evidence.quoteVersion !== next.quote.quoteVersion ||
        evidence.purpose !== (isProposal ? 'QUOTE' : 'ACTUAL')
      )
        return fail('EVIDENCE_MISMATCH');
    }
    const root = {
      version: next.version,
      quoteVersion: next.quote.quoteVersion,
      status: next.status,
      projection: projection(next),
    };
    if (!session)
      await manager.insert(DeliveryConsentSession, {
        ...root,
        partRequestId: requestId,
        serviceOrderId: order.id,
        customerId: scope.customerId,
        technicianId: scope.technicianId,
        responsibleServiceManagerId: scope.responsibleServiceManagerId,
        assignmentId,
        warehouseId,
        sourceQuotationId: request.quotationId ?? null,
        sourceAdditionalCostId: request.additionalCostId ?? null,
        invalidatedAt: null,
        invalidationReason: null,
      });
    else if (
      (
        await manager.update(
          DeliveryConsentSession,
          {
            partRequestId: requestId,
            version: state!.version,
            invalidatedAt: IsNull(),
          },
          { ...root, updatedAt: new Date() },
        )
      ).affected !== 1
    )
      return fail('CAS_CONFLICT');
    const q = next.quote;
    await manager.insert(DeliveryConsentCommandRecord, {
      partRequestId: requestId,
      commandId: receipt.commandId,
      kind: command.kind,
      actorUserId: actor.id,
      actorRole: actor.role,
      expectedVersion: command.expectedVersion,
      resultVersion: next.version,
      quoteVersion: q.quoteVersion,
      quoteCommandId: isProposal ? command.commandId : parent!.commandId,
      commandBody: receipt.command,
      contentFingerprint: receipt.contentFingerprint,
      sourceSnapshot: source.snapshot,
      sourceDigest: source.digest,
      sourceVersion: source.version,
      evidenceId,
      snapshot: projection(next),
      shippingTotal: q.totalShippingFee,
      customerShare: q.customerShippingShare,
      technicianShare: q.technicianShippingShare,
      laborTotal: q.budget.laborTotal,
      commissionAmount: q.budget.commissionAmount,
      knownDeductions: q.budget.knownApprovedDeductions,
      netLabor: q.netLaborAfterShipping,
      actualTotal:
        command.kind === 'RECORD_ACTUAL' ? next.actual!.totalShippingFee : null,
      actualCustomerShare:
        command.kind === 'RECORD_ACTUAL'
          ? next.actual!.customerShippingShare
          : null,
      actualTechnicianShare:
        command.kind === 'RECORD_ACTUAL'
          ? next.actual!.technicianShippingShare
          : null,
      consentShare: command.kind === 'CONSENT' ? command.shippingShare : null,
    });
    await this.audit(manager, requestId, actor, 'DELIVERY_CONSENT_RECORDED', {
      commandId: receipt.commandId,
      version: next.version,
      kind: command.kind,
    });
    return { state: next, receipt, replayed: false };
  }

  async appendEvidence(
    manager: EntityManager,
    requestId: string,
    metadata: EvidenceMetadata,
    actor: DeliveryActor,
  ): Promise<DeliveryEvidenceRecord> {
    this.transaction(manager);
    if (actor.role !== Role.SERVICE_MANAGER) return fail('ACTOR_DENIED');
    const keys = [
      'id',
      'purpose',
      'quoteVersion',
      'privateObjectRef',
      'contentDigest',
      'mimeType',
      'fileSize',
      'retainUntil',
    ];
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.getOwnPropertySymbols(metadata).length ||
      Object.keys(metadata).length !== keys.length ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(metadata, key))
    )
      return fail('EVIDENCE_INVALID');
    const current = await this.scope(manager, requestId, actor.id);
    const prefix = `cloudinary://evidence/fixhome/evidence/${current.order.id}/${actor.id}/`;
    if (
      !uuid.test(metadata.id) ||
      !['QUOTE', 'ACTUAL'].includes(metadata.purpose) ||
      !Number.isSafeInteger(metadata.quoteVersion) ||
      metadata.quoteVersion < 1 ||
      metadata.quoteVersion > 2_147_483_647 ||
      typeof metadata.privateObjectRef !== 'string' ||
      !metadata.privateObjectRef.startsWith(prefix) ||
      !uuid.test(metadata.privateObjectRef.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/.test(metadata.contentDigest) ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(metadata.mimeType) ||
      !Number.isInteger(metadata.fileSize) ||
      metadata.fileSize < 1 ||
      metadata.fileSize > 10 * 1024 * 1024 ||
      (metadata.retainUntil !== null &&
        (!(metadata.retainUntil instanceof Date) ||
          !Number.isFinite(metadata.retainUntil.getTime())))
    )
      return fail('EVIDENCE_INVALID');
    const row = {
      ...metadata,
      partRequestId: requestId,
      serviceOrderId: current.order.id,
      uploaderUserId: actor.id,
    };
    const previous = await manager.findOne(DeliveryEvidenceRecord, {
      where: { id: metadata.id },
    });
    if (previous) {
      const { createdAt: _createdAt, ...stored } = previous;
      if (!equal(stored, row)) return fail('EVIDENCE_CONFLICT');
      return previous;
    }
    await manager.insert(DeliveryEvidenceRecord, row);
    return row as DeliveryEvidenceRecord;
  }

  async invalidateIfScopeChanged(
    manager: EntityManager,
    requestId: string,
  ): Promise<boolean> {
    this.transaction(manager);
    const ref = await manager.findOne(DeliveryConsentSession, {
      where: { partRequestId: requestId },
    });
    if (!ref || ref.invalidatedAt) return false;
    await manager.findOne(ServiceOrder, {
      where: { id: ref.serviceOrderId },
      lock: { mode: 'pessimistic_write' },
    });
    await manager.findOne(User, {
      where: { id: ref.technicianId },
      lock: { mode: 'pessimistic_write' },
    });
    const request = await manager.findOne(PartRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    const session = await manager.findOne(DeliveryConsentSession, {
      where: { partRequestId: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!session || session.invalidatedAt) return false;
    const order = await manager.findOne(ServiceOrder, {
      where: { id: session.serviceOrderId },
    });
    const booking = order
      ? await manager.findOne(Booking, { where: { id: order.bookingId } })
      : null;
    const assignment = await manager.findOne(TechnicianAssignment, {
      where: {
        id: session.assignmentId,
        isActive: true,
        serviceOrderId: session.serviceOrderId,
        technicianId: session.technicianId,
      },
    });
    if (
      request?.serviceOrderId === session.serviceOrderId &&
      request.technicianId === session.technicianId &&
      booking?.customerId === session.customerId &&
      assignment &&
      request.fulfillmentMethod === 'delivery' &&
      (request.quotationId ?? null) === session.sourceQuotationId &&
      (request.additionalCostId ?? null) === session.sourceAdditionalCostId
    )
      return false;
    if (
      (
        await manager.update(
          DeliveryConsentSession,
          {
            partRequestId: requestId,
            version: session.version,
            invalidatedAt: IsNull(),
          },
          {
            invalidatedAt: new Date(),
            invalidationReason: 'SCOPE_CHANGED',
            updatedAt: new Date(),
          },
        )
      ).affected !== 1
    )
      return fail('CAS_CONFLICT');
    // Internal maintenance, not a claim that the historical SM authenticated this action.
    await this.audit(
      manager,
      requestId,
      null,
      'DELIVERY_CONSENT_SCOPE_INVALIDATED',
      { version: session.version },
    );
    return true;
  }

  private async audit(
    manager: EntityManager,
    requestId: string,
    actor: DeliveryActor | null,
    action: string,
    after: Record<string, unknown>,
  ) {
    await manager.insert(AuditLog, {
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action,
      resourceType: 'delivery_consent',
      resourceId: requestId,
      after,
    });
  }
}

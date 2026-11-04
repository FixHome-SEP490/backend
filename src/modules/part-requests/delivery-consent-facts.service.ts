import { EntityManager } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { User } from '../users/entities/user.entity';
import { PartRequest } from './entities/part-request.entity';
import {
  assertDeliveryPreviewOwner,
  assertDeliveryPreviewRole,
  deliveryPreviewId,
  deliveryPreviewPrincipal,
  denyDeliveryPreview,
} from './delivery-consent-access.policy';

const mandatoryBlockers = [
  'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
  'WAREHOUSE_DELIVERY_ALLOCATION_MISSING',
  'COURIER_PROOF_UNVERIFIED',
  'FINANCE_CUTOVER_CLOSED',
  'TOTAL_ORDER_LABOR_BUDGET_UNVERIFIED',
] as const;
type PreviewBlocker =
  | (typeof mandatoryBlockers)[number]
  | 'ORDER_FROZEN'
  | 'ORDER_INVOICED'
  | 'REQUEST_FROZEN'
  | 'REQUEST_KIND_UNSUPPORTED'
  | 'FULFILLMENT_NOT_DELIVERY'
  | 'SOURCE_BINDING_UNVERIFIED'
  | 'PARTS_LABOR_SOURCE_NOT_APPROVED';
interface SourceFacts {
  readonly kind: 'ADDITIONAL_COST' | 'QUOTATION' | 'UNRESOLVED';
  readonly partsLaborApproval:
    'VERIFIED_APPROVED' | 'NOT_APPROVED' | 'UNVERIFIED';
  readonly shippingApproval: 'UNVERIFIED';
  readonly version: number | null;
}
const actions = Object.freeze({
  newConsent: 'BLOCKED',
  proposal: 'BLOCKED',
  dispatch: 'BLOCKED',
  payout: 'BLOCKED',
} as const);
const userFields = ['id', 'role', 'isActive', 'status'] as const;

/** B2a INERT owner preview only. Not registered, no JWT authentication, transaction, locks,
 * persistence or external calls. Requires a future trusted guard, not body-supplied actors.
 * Reads can race/reassign/change between statements; never feed this result to a mutation.
 * B1 tables are deliberately NOT read (0005 is unapplied). No W2 allocation/evidence fallback.
 * Mandatory blockers reflect missing authority, not a claim that private objects were inspected. */
export class DeliveryConsentFactsService {
  async preview(
    manager: EntityManager,
    requestInput: string,
    actorInput: unknown,
  ) {
    const requestId = deliveryPreviewId(requestInput);
    const principal = deliveryPreviewPrincipal(actorInput);
    const user = await manager.findOne(User, {
      where: { id: principal.id },
      select: [...userFields],
    });
    // SM/Admin may not probe request existence using a broad service role.
    assertDeliveryPreviewRole(principal, user);
    const request = await manager.findOne(PartRequest, {
      where: { id: requestId },
      select: ['id', 'serviceOrderId', 'technicianId'],
    });
    if (!request) return denyDeliveryPreview();
    const order = await manager.findOne(ServiceOrder, {
      where: { id: request.serviceOrderId },
      select: ['id', 'bookingId'],
    });
    if (!order) return denyDeliveryPreview();
    const booking = await manager.findOne(Booking, {
      where: { id: order.bookingId },
      select: ['id', 'customerId'],
    });
    if (!booking) return denyDeliveryPreview();
    const assignment = await manager.findOne(TechnicianAssignment, {
      where: {
        serviceOrderId: order.id,
        technicianId: request.technicianId,
        isActive: true,
      },
      select: ['id', 'serviceOrderId', 'technicianId', 'isActive'],
    });
    const technician =
      user.id === request.technicianId
        ? user
        : await manager.findOne(User, {
            where: { id: request.technicianId },
            select: [...userFields],
          });
    assertDeliveryPreviewOwner(principal, {
      request,
      order,
      booking,
      assignment,
      technician,
    });
    // Only after the identifier-only owner gate may status/source fields be selected.
    // Pin every fetch to the identities just checked; reject observed moves/reassignment.
    // These unlocked reads remain NON_ATOMIC, never a mutation authorization snapshot.
    const currentRequest = await manager.findOne(PartRequest, {
      where: {
        id: request.id,
        serviceOrderId: order.id,
        technicianId: request.technicianId,
      },
      select: [
        'id',
        'serviceOrderId',
        'technicianId',
        'requestType',
        'fulfillmentMethod',
        'status',
        'additionalCostId',
        'quotationId',
      ],
    });
    if (
      !currentRequest ||
      currentRequest.id !== request.id ||
      currentRequest.serviceOrderId !== order.id ||
      currentRequest.technicianId !== request.technicianId
    )
      return denyDeliveryPreview();
    const currentOrder = await manager.findOne(ServiceOrder, {
      where: { id: order.id, bookingId: booking.id },
      select: ['id', 'bookingId', 'status', 'completionRequestedAt'],
    });
    if (
      !currentOrder ||
      currentOrder.id !== order.id ||
      currentOrder.bookingId !== booking.id
    )
      return denyDeliveryPreview();
    const currentBooking = await manager.findOne(Booking, {
      where: { id: booking.id, customerId: booking.customerId },
      select: ['id', 'customerId'],
    });
    if (
      !currentBooking ||
      currentBooking.id !== booking.id ||
      currentBooking.customerId !== booking.customerId
    )
      return denyDeliveryPreview();
    const currentAssignment = await manager.findOne(TechnicianAssignment, {
      where: {
        id: assignment.id,
        serviceOrderId: order.id,
        technicianId: request.technicianId,
        isActive: true,
      },
      select: ['id', 'serviceOrderId', 'technicianId', 'isActive'],
    });
    if (!currentAssignment || currentAssignment.id !== assignment.id)
      return denyDeliveryPreview();
    const currentUser = await manager.findOne(User, {
      where: { id: principal.id },
      select: [...userFields],
    });
    assertDeliveryPreviewRole(principal, currentUser);
    const currentTechnician =
      currentUser.id === request.technicianId
        ? currentUser
        : await manager.findOne(User, {
            where: { id: request.technicianId },
            select: [...userFields],
          });
    assertDeliveryPreviewOwner(principal, {
      request: currentRequest,
      order: currentOrder,
      booking: currentBooking,
      assignment: currentAssignment,
      technician: currentTechnician,
    });
    // Source/invoice only follow both owner checks. No money, QR, private references or profile.
    const source = await this.source(
      manager,
      currentRequest,
      currentBooking.customerId,
    );
    const invoiced = await manager.existsBy(Invoice, {
      serviceOrderId: currentOrder.id,
    });
    const blockers: PreviewBlocker[] = [...mandatoryBlockers];
    if (
      !['accepted', 'en_route', 'under_repair'].includes(currentOrder.status) ||
      currentOrder.completionRequestedAt != null
    )
      blockers.push('ORDER_FROZEN');
    if (invoiced) blockers.push('ORDER_INVOICED');
    // DELIVERING already represents the historical physical flow, not a fresh consent grant.
    if (!['requested', 'ready'].includes(currentRequest.status))
      blockers.push('REQUEST_FROZEN');
    if (!['additional', 'quotation'].includes(currentRequest.requestType))
      blockers.push('REQUEST_KIND_UNSUPPORTED');
    if (currentRequest.fulfillmentMethod !== 'delivery')
      blockers.push('FULFILLMENT_NOT_DELIVERY');
    if (source.partsLaborApproval === 'UNVERIFIED')
      blockers.push('SOURCE_BINDING_UNVERIFIED');
    if (source.partsLaborApproval === 'NOT_APPROVED')
      blockers.push('PARTS_LABOR_SOURCE_NOT_APPROVED');
    return Object.freeze({
      mode: 'NON_EXECUTABLE_PREVIEW' as const,
      consistency: 'NON_ATOMIC' as const,
      actor: Object.freeze({ id: currentUser.id, role: currentUser.role }),
      requestId: currentRequest.id,
      serviceOrderId: currentOrder.id,
      observed: Object.freeze({
        requestType: currentRequest.requestType,
        fulfillmentMethod: currentRequest.fulfillmentMethod,
        requestStatus: currentRequest.status,
        orderStatus: currentOrder.status,
      }),
      source: Object.freeze(source),
      blockers: Object.freeze(blockers),
      actions,
    });
  }

  private async source(
    manager: EntityManager,
    request: PartRequest,
    customerId: string,
  ): Promise<SourceFacts> {
    const unverified: SourceFacts = {
      kind: 'UNRESOLVED',
      partsLaborApproval: 'UNVERIFIED',
      shippingApproval: 'UNVERIFIED',
      version: null,
    };
    if (!!request.additionalCostId === !!request.quotationId) return unverified;
    const quotation =
      request.requestType === 'quotation' && !!request.quotationId;
    const additional =
      request.requestType === 'additional' && !!request.additionalCostId;
    if (!quotation && !additional) return unverified;
    const source = quotation
      ? await manager.findOne(Quotation, {
          where: { id: request.quotationId! },
          select: [
            'id',
            'serviceOrderId',
            'technicianId',
            'status',
            'decidedAt',
            'version',
          ],
        })
      : await manager.findOne(AdditionalCostRequest, {
          where: { id: request.additionalCostId! },
          select: [
            'id',
            'serviceOrderId',
            'technicianId',
            'status',
            'decidedAt',
            'decidedByCustomerId',
          ],
        });
    const kind = quotation ? 'QUOTATION' : 'ADDITIONAL_COST';
    if (
      !source ||
      source.serviceOrderId !== request.serviceOrderId ||
      source.technicianId !== request.technicianId
    )
      return { ...unverified, kind };
    if (source.status !== 'approved')
      return { ...unverified, kind, partsLaborApproval: 'NOT_APPROVED' };
    if (
      !(source.decidedAt instanceof Date) ||
      !Number.isFinite(source.decidedAt.getTime()) ||
      (!quotation &&
        (source as AdditionalCostRequest).decidedByCustomerId !== customerId)
    )
      return { ...unverified, kind };
    const version = quotation ? (source as Quotation).version : null;
    if (
      quotation &&
      (version === null || !Number.isSafeInteger(version) || version < 1)
    )
      return { ...unverified, kind };
    return {
      kind,
      partsLaborApproval: 'VERIFIED_APPROVED',
      shippingApproval: 'UNVERIFIED',
      version,
    };
  }
}

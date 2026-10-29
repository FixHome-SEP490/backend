import { ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BookingStatus, Role, ServiceOrderStatus, SupportCaseStatus } from '../../shared/enums';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { Address } from '../users/entities/address.entity';
import { Service } from '../services/entities/service.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { Booking } from './entities/booking.entity';
import { InterruptionRebookSource } from './entities/interruption-rebook.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { hasOnsiteInterruption, ONSITE_INTERRUPTION_ACTION, verifiedOnsiteInterruption } from '../service-orders/onsite-interruption';

const deny = (): never => { throw new ForbiddenException('Interrupted order not found or access denied'); };

/** Manager-close sources and strict onsite receipts share the existing fresh-booking confirmation. */
export async function buildInterruptionDraft(manager: EntityManager, anchorId: string, actor: { id: string; role: string }, lockSources = false) {
  if (actor.role !== Role.CUSTOMER) deny();
  const anchor = await manager.findOneBy(Booking, { id: anchorId, customerId: actor.id });
  if (!anchor || ![BookingStatus.CANCELLED, BookingStatus.MATCHED].includes(anchor.status)) deny();
  const groupItems = anchor.visitGroupId
    ? await manager.find(VisitGroupItem, { where: { groupId: anchor.visitGroupId }, order: { sequence: 'ASC' } }) : [];
  if (anchor.visitGroupId && !groupItems.some(item => item.bookingId === anchorId)) deny();
  const candidates = anchor.visitGroupId ? groupItems.filter(item => item.outcome === 'interrupted' || item.outcome == null).map(item => item.bookingId) : [anchor.id];
  const sourceIds: string[] = [];
  for (const sourceId of candidates) {
    if (!await manager.findOneBy(InterruptionRebookSource, { sourceBookingId: sourceId })) sourceIds.push(sourceId);
  }
  if (!sourceIds.includes(anchorId)) deny();
  if (!sourceIds.length || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length) deny();
  const items = [];
  for (const sourceId of sourceIds) {
    const booking = lockSources
      ? await manager.findOne(Booking, { where: { id: sourceId, customerId: actor.id }, lock: { mode: 'pessimistic_write' } })
      : sourceId === anchor.id ? anchor : await manager.findOneBy(Booking, { id: sourceId, customerId: actor.id });
    if (!booking || booking.visitGroupId !== anchor.visitGroupId) deny();
    const order = lockSources
      ? await manager.findOne(ServiceOrder, { where: { bookingId: sourceId }, lock: { mode: 'pessimistic_write' } })
      : await manager.findOneBy(ServiceOrder, { bookingId: sourceId });
    if (!order) deny();
    const receipts = await manager.find(AuditLog, { where: {
      action: ONSITE_INTERRUPTION_ACTION, resourceType: 'service_order', resourceId: order.id,
    } });
    let sourceCase: SupportCase;
    if (receipts.length || await hasOnsiteInterruption(manager, order.id)) {
      // A damaged onsite receipt must never fall back to manager case prose.
      const proof = await verifiedOnsiteInterruption(manager, order, booking);
      if (!proof || booking.quantity !== 1) deny();
      sourceCase = proof.incident;
    } else {
      // Open unaffected siblings are not sources. Completed/failed siblings were
      // already excluded by outcome; objective failures keep their own API.
      if (booking.visitGroupId && groupItems.find(item => item.bookingId === sourceId)?.outcome !== 'interrupted') continue;
      if (booking.status !== BookingStatus.CANCELLED || order.status !== ServiceOrderStatus.CANCELLED) continue;
      sourceCase = await manager.findOneBy(SupportCase, {
        serviceOrderId: order.id, customerId: actor.id,
        status: SupportCaseStatus.RESOLVED, resolutionCode: 'interrupted_for_rebook',
      });
      if (!sourceCase?.interruptionCommandId || !sourceCase.technicianId
        || (sourceCase.bookingId != null && sourceCase.bookingId !== sourceId)) deny();
    }
    const service = await manager.findOneBy(Service, { id: booking.serviceId, isActive: true });
    if (!service) deny();
    items.push({ sourceBookingId: sourceId, sourceOrderId: order.id, sourceCaseId: sourceCase.id,
      serviceId: booking.serviceId, deviceLabel: groupItems.find(item => item.bookingId === sourceId)?.deviceLabel ?? null,
      selectedVariantCode: booking.catalogV2PricingSnapshot?.selectedVariant?.variantCode ?? null,
      description: booking.description ?? '', deviceAttributes: booking.deviceAttributesSnapshot ?? null,
      quantity: 1, photos: [], previousTechnicianId: sourceCase.technicianId });
  }
  if (!items.some(item => item.sourceBookingId === anchorId)) deny();
  const address = anchor.addressId && await manager.findOneBy(Address, { id: anchor.addressId, userId: actor.id });
  return { sourceVisitGroupId: anchor.visitGroupId ?? null, targetKind: items.length === 1 ? 'booking' as const : 'visit_group' as const,
    address: { id: address ? anchor.addressId : null, text: address ? [address.line1, address.ward, address.district, address.province].filter(Boolean).join(', ') : null },
    customerNote: anchor.customerNote ?? null, items, requiresNewSchedule: true, requiresPricingRevalidation: true,
    confirmation: { available: true, path: `/api/v1/bookings/${anchorId}/interruption-rebook` } };
}

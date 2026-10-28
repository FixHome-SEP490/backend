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

const deny = (): never => { throw new ForbiddenException('Interrupted order not found or access denied'); };

/** Only a manager command receipt can provide this customer-owned fresh-booking source. */
export async function buildInterruptionDraft(manager: EntityManager, anchorId: string, actor: { id: string; role: string }) {
  if (actor.role !== Role.CUSTOMER) deny();
  const anchor = await manager.findOneBy(Booking, { id: anchorId, customerId: actor.id });
  if (!anchor || anchor.status !== BookingStatus.CANCELLED) deny();
  const groupItems = anchor.visitGroupId
    ? await manager.find(VisitGroupItem, { where: { groupId: anchor.visitGroupId }, order: { sequence: 'ASC' } }) : [];
  if (anchor.visitGroupId && !groupItems.some(item => item.bookingId === anchorId && item.outcome === 'interrupted')) deny();
  const candidates = anchor.visitGroupId ? groupItems.filter(item => item.outcome === 'interrupted').map(item => item.bookingId) : [anchor.id];
  const sourceIds: string[] = [];
  for (const sourceId of candidates) {
    if (!await manager.findOneBy(InterruptionRebookSource, { sourceBookingId: sourceId })) sourceIds.push(sourceId);
  }
  if (!sourceIds.includes(anchorId)) deny();
  if (!sourceIds.length || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length) deny();
  const items = [];
  for (const sourceId of sourceIds) {
    const booking = sourceId === anchor.id ? anchor : await manager.findOneBy(Booking, { id: sourceId, customerId: actor.id });
    if (!booking || booking.status !== BookingStatus.CANCELLED || booking.visitGroupId !== anchor.visitGroupId) deny();
    const order = await manager.findOneBy(ServiceOrder, { bookingId: sourceId });
    if (!order || order.status !== ServiceOrderStatus.CANCELLED) deny();
    const sourceCase = await manager.findOneBy(SupportCase, {
      serviceOrderId: order.id, customerId: actor.id,
      status: SupportCaseStatus.RESOLVED, resolutionCode: 'interrupted_for_rebook',
    });
    if (!sourceCase?.interruptionCommandId || !sourceCase.technicianId
      || (sourceCase.bookingId != null && sourceCase.bookingId !== sourceId)) deny();
    const service = await manager.findOneBy(Service, { id: booking.serviceId, isActive: true });
    if (!service) deny();
    items.push({ sourceBookingId: sourceId, sourceOrderId: order.id, sourceCaseId: sourceCase.id,
      serviceId: booking.serviceId, deviceLabel: groupItems.find(item => item.bookingId === sourceId)?.deviceLabel ?? null,
      selectedVariantCode: booking.catalogV2PricingSnapshot?.selectedVariant?.variantCode ?? null,
      description: booking.description ?? '', deviceAttributes: booking.deviceAttributesSnapshot ?? null,
      quantity: 1, photos: [], previousTechnicianId: sourceCase.technicianId });
  }
  const address = anchor.addressId && await manager.findOneBy(Address, { id: anchor.addressId, userId: actor.id });
  return { sourceVisitGroupId: anchor.visitGroupId ?? null, targetKind: items.length === 1 ? 'booking' as const : 'visit_group' as const,
    address: { id: address ? anchor.addressId : null, text: address ? [address.line1, address.ward, address.district, address.province].filter(Boolean).join(', ') : null },
    customerNote: anchor.customerNote ?? null, items, requiresNewSchedule: true, requiresPricingRevalidation: true,
    confirmation: { available: true, path: `/api/v1/bookings/${anchorId}/interruption-rebook` } };
}

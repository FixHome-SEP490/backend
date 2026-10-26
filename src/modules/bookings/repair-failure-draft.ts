import { ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, Role } from '../../shared/enums';
import { repairFailureIncident } from '../service-orders/repair-failure-incident';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Address } from '../users/entities/address.entity';
import { Service } from '../services/entities/service.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { RepairFailureRebookSource } from './entities/repair-failure-rebook.entity';
import type { RepairFailureDraftDto, RepairFailureDraftItem } from './dto/repair-failure-draft.dto';

const deny = (): never => { throw new ForbiddenException('Failed repair not found or access denied'); };

/** Read-only form data; confirmation validates the incident again under a source lock. */
export async function buildRepairFailureDraft(manager: EntityManager, bookingId: string, actor: { id: string; role: string }): Promise<RepairFailureDraftDto> {
  if (actor.role !== Role.CUSTOMER) deny();
  const anchor = await manager.findOneBy(Booking, { id: bookingId, customerId: actor.id });
  if (!anchor || anchor.status !== BookingStatus.CANCELLED) deny();
  const failedItems = anchor.visitGroupId
    ? await manager.find(VisitGroupItem, { where: { groupId: anchor.visitGroupId, outcome: 'failed' }, order: { sequence: 'ASC' } })
    : [];
  if (anchor.visitGroupId && !failedItems.some(item => item.bookingId === anchor.id)) deny();
  const sourceIds = anchor.visitGroupId ? failedItems.map(item => item.bookingId) : [anchor.id];
  if (!sourceIds.length || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length) deny();
  const items: RepairFailureDraftItem[] = [];
  for (const sourceId of sourceIds) {
    if (await manager.findOneBy(RepairFailureRebookSource, { sourceBookingId: sourceId })) deny();
    const booking = sourceId === anchor.id ? anchor : await manager.findOneBy(Booking, { id: sourceId, customerId: actor.id });
    if (!booking || booking.status !== BookingStatus.CANCELLED || booking.visitGroupId !== anchor.visitGroupId) deny();
    const order = await manager.findOneBy(ServiceOrder, { bookingId: sourceId });
    const source = order && await repairFailureIncident(manager, order);
    if (!source || source.incident.customerId !== actor.id) deny();
    const service = await manager.findOneBy(Service, { id: booking.serviceId, isActive: true });
    if (!service) throw new BusinessException(ErrorCodes.NOT_FOUND, 'Dịch vụ của thiết bị đã ngừng. Vui lòng chọn dịch vụ mới.');
    const photos: RepairFailureDraftItem['photos'] = [];
    const media = await manager.find(BookingMedia, { where: { bookingId: sourceId } });
    for (const photo of media) {
      if (!photo.privateUploadId || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.mimeType)) continue;
      const upload = await manager.findOneBy(PrivateBookingPhotoUpload, { id: photo.privateUploadId, claimedBookingId: sourceId, ownerUserId: actor.id });
      // Claimed booking photos use their original authorized read route. Their
      // former upload deadline is not a new claim token and is never returned.
      if (!upload?.objectRef || upload.mimeType !== photo.mimeType) continue;
      photos.push({ mediaId: photo.id, sourceBookingId: sourceId, contentPath: `/api/v1/bookings/${sourceId}/media/${photo.id}/content` });
    }
    items.push({
      sourceBookingId: sourceId, sourceOrderId: order.id, sourceIncidentId: source.incident.id,
      serviceId: booking.serviceId, deviceLabel: failedItems.find(item => item.bookingId === sourceId)?.deviceLabel ?? null,
      selectedVariantCode: booking.catalogV2PricingSnapshot?.selectedVariant?.variantCode ?? null,
      description: booking.description ?? '', deviceAttributes: booking.deviceAttributesSnapshot ?? null,
      quantity: 1, photos,
    });
  }
  const address = anchor.addressId && await manager.findOneBy(Address, { id: anchor.addressId, userId: actor.id });
  return {
    sourceVisitGroupId: anchor.visitGroupId ?? null,
    targetKind: items.length === 1 ? 'booking' : 'visit_group',
    address: { id: address ? anchor.addressId : null, text: address ? [address.line1, address.ward, address.district, address.province].filter(Boolean).join(', ') : null },
    customerNote: anchor.customerNote ?? null, items,
    requiresNewSchedule: true, requiresPricingRevalidation: true,
    confirmation: { available: true, path: `/api/v1/bookings/${anchor.id}/repair-failure-rebook` },
  };
}

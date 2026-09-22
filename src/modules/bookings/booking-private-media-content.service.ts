import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { PrivateBookingPhotoStorage } from '../media/private-booking-photo-storage.service';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { isUUID } from 'class-validator';
import { BookingMedia } from './entities/booking-media.entity';
import { Booking } from './entities/booking.entity';

const MAX_PRIVATE_IMAGE_BYTES = 10 * 1024 * 1024;
const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface PrivateBookingImageContent {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

@Injectable()
export class BookingPrivateMediaContentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly privateStorage: PrivateBookingPhotoStorage,
  ) {}

  async download(
    bookingId: string,
    mediaId: string,
    actor: { id: string; role: string },
  ): Promise<PrivateBookingImageContent> {
    if (!isUUID(bookingId) || !isUUID(mediaId) || !actor || !isUUID(actor.id)) this.notFound();

    const authorizedObject = await this.dataSource.transaction(async manager => {
      // Lock order is Booking -> ServiceOrder -> TechnicianAssignment. This matches
      // booking matching/withdrawal flows and prevents a reassignment snapshot from
      // being read halfway through its transaction.
      const booking = await manager.findOne(Booking, {
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!booking) this.notFound();

      const isStaff = actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER;
      const isOwner = actor.role === Role.CUSTOMER && actor.id === booking.customerId;
      if (!isStaff && !isOwner) {
        if (actor.role !== Role.TECHNICIAN || booking.status !== BookingStatus.MATCHED) this.notFound();

        const order = await manager.findOne(ServiceOrder, {
          where: { bookingId: booking.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!order || order.status === ServiceOrderStatus.CANCELLED) this.notFound();

        const assignment = await manager.findOne(TechnicianAssignment, {
          where: { serviceOrderId: order.id, technicianId: actor.id, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (!assignment) this.notFound();
      }

      const media = await manager.findOne(BookingMedia, {
        where: { id: mediaId, bookingId: booking.id },
      });
      if (!media || !media.privateUploadId || !isUUID(media.privateUploadId)) this.notFound();

      const upload = await manager.findOne(PrivateBookingPhotoUpload, {
        where: { id: media.privateUploadId },
      });
      if (
        !upload ||
        upload.id !== media.privateUploadId ||
        upload.claimedBookingId !== booking.id ||
        upload.ownerUserId !== booking.customerId ||
        typeof upload.objectRef !== 'string' ||
        upload.objectRef.length === 0
      ) {
        this.notFound();
      }

      return { objectRef: upload.objectRef, ownerUserId: upload.ownerUserId };
    });

    // The DB authorization snapshot is committed before provider I/O. A reassignment or
    // cancellation may begin after that commit and before bytes finish downloading; keeping
    // DB locks across the remote request would hold scarce connections and risk lock stalls.
    try {
      const content = await this.privateStorage.download(
        authorizedObject.objectRef,
        authorizedObject.ownerUserId,
      );
      if (
        !content ||
        !Buffer.isBuffer(content.buffer) ||
        content.buffer.length === 0 ||
        content.buffer.length > MAX_PRIVATE_IMAGE_BYTES ||
        !SAFE_IMAGE_MIME_TYPES.has(content.mimeType)
      ) {
        throw new Error('Invalid private Booking image content');
      }
      return content;
    } catch {
      // Do not expose storage references, provider response bodies, or secret-bearing errors.
      throw new ServiceUnavailableException('Private Booking photo content is unavailable');
    }
  }

  private notFound(): never {
    throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Booking media not found');
  }
}

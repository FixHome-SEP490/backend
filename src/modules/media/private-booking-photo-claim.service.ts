import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { EntityManager, IsNull, MoreThan } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';

const MAX_BOOKING_PHOTO_UPLOADS = 5;

export type PrivateBookingPhotoClaimMetadata = {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
};

@Injectable()
export class PrivateBookingPhotoClaimService {
  /**
   * Claims uploads through the caller's active transaction. The caller must let failures
   * escape its transaction callback so any earlier row updates are rolled back.
   */
  async claim(
    manager: EntityManager,
    ownerUserId: string,
    bookingId: string,
    uploadIds: readonly string[],
  ): Promise<PrivateBookingPhotoClaimMetadata[]> {
    if (!manager?.queryRunner?.isTransactionActive) {
      throw new BusinessException(
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Booking photo claim could not be completed',
      );
    }

    if (
      !isUUID(ownerUserId) ||
      !isUUID(bookingId) ||
      !Array.isArray(uploadIds) ||
      uploadIds.length > MAX_BOOKING_PHOTO_UPLOADS ||
      uploadIds.some((uploadId) => typeof uploadId !== 'string' || !isUUID(uploadId))
    ) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Provide at most five distinct valid Booking photo upload IDs',
      );
    }

    const normalizedOwnerUserId = ownerUserId.toLowerCase();
    const normalizedBookingId = bookingId.toLowerCase();
    const normalizedUploadIds = uploadIds.map((uploadId) => uploadId.toLowerCase());
    if (new Set(normalizedUploadIds).size !== normalizedUploadIds.length) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Provide at most five distinct valid Booking photo upload IDs',
      );
    }

    const now = new Date();
    const orderedUploadIds = [...normalizedUploadIds].sort();
    const lockedUploads: PrivateBookingPhotoUpload[] = [];

    try {
      for (const uploadId of orderedUploadIds) {
        const upload = await manager.findOne(PrivateBookingPhotoUpload, {
          where: { id: uploadId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!upload) this.throwUploadUnavailable();
        lockedUploads.push(upload);
      }

      if (
        lockedUploads.some((upload) => {
          const expiresAt = upload.expiresAt;
          return (
            upload.ownerUserId !== normalizedOwnerUserId ||
            upload.claimedBookingId !== null ||
            !(expiresAt instanceof Date) ||
            !Number.isFinite(expiresAt.getTime()) ||
            expiresAt.getTime() <= now.getTime()
          );
        })
      ) {
        this.throwUploadUnavailable();
      }

      for (const upload of lockedUploads) {
        const result = await manager.update(
          PrivateBookingPhotoUpload,
          {
            id: upload.id,
            ownerUserId: normalizedOwnerUserId,
            claimedBookingId: IsNull(),
            expiresAt: MoreThan(now),
          },
          { claimedBookingId: normalizedBookingId },
        );
        if (result.affected !== 1) this.throwUploadUnavailable();
      }

      return lockedUploads.map((upload) => ({
        uploadId: upload.id,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
      }));
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException(
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Booking photo claim could not be completed',
      );
    }
  }

  private throwUploadUnavailable(): never {
    throw new BusinessException(
      ErrorCodes.OWNERSHIP_DENIED,
      'One or more Booking photo uploads are unavailable',
    );
  }
}

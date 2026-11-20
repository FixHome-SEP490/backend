import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { startBackgroundJob } from '../../common/background-job';
import { BusinessException } from '../../common/exceptions/business.exception';
import { Role } from '../../shared/enums';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import {
  PrivateBookingPhotoFile,
  PrivateBookingPhotoStorage,
} from './private-booking-photo-storage.service';

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
/** An expired upload can no longer be claimed; wait a day anyway before deleting it. */
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;

export type PrivateBookingPhotoUploadResponse = {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
};

@Injectable()
export class PrivateBookingPhotoUploadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrivateBookingPhotoUploadService.name);
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(PrivateBookingPhotoUpload)
    private readonly uploadRepository: Repository<PrivateBookingPhotoUpload>,
    private readonly privateStorage: PrivateBookingPhotoStorage,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = startBackgroundJob('booking upload sweep', this.logger, async () => { await this.sweepExpiredUploads(); });
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Deletes the Cloudinary object and the row of uploads that expired without being attached to a Booking. */
  async sweepExpiredUploads(now = new Date()): Promise<number> {
    const stale = await this.uploadRepository.find({
      where: { claimedBookingId: IsNull(), expiresAt: LessThan(new Date(now.getTime() - SWEEP_GRACE_MS)) },
      order: { expiresAt: 'ASC' },
      take: SWEEP_BATCH,
    });
    let removed = 0;
    for (const upload of stale) {
      try {
        await this.privateStorage.delete(upload.objectRef, upload.ownerUserId);
        await this.uploadRepository.delete({ id: upload.id, claimedBookingId: IsNull() });
        removed += 1;
      } catch (error) {
        // Row stays, so the next run retries it.
        this.logger.warn(`Could not remove expired booking upload ${upload.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return removed;
  }

  async upload(
    role: Role,
    ownerUserId: string,
    file?: PrivateBookingPhotoFile,
  ): Promise<PrivateBookingPhotoUploadResponse> {
    if (role !== Role.CUSTOMER) {
      throw new ForbiddenException('Only customers can upload Booking photos');
    }

    this.privateStorage.validate(file);

    let objectRef: string;
    try {
      objectRef = await this.privateStorage.upload(ownerUserId, file);
    } catch {
      throw new ServiceUnavailableException('Private Booking photo upload is unavailable');
    }

    try {
      const metadata = this.uploadRepository.create({
        ownerUserId,
        objectRef,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        claimedBookingId: null,
      });
      const saved = await this.uploadRepository.save(metadata);

      return {
        uploadId: saved.id,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      };
    } catch {
      // TODO(B2a): Plan bounded cleanup for private objects whose metadata save failed. Never delete
      // objects inline; cleanup must be separately reviewed and must preserve customer ownership.
      throw new ServiceUnavailableException(
        'Private Booking photo metadata could not be saved',
      );
    }
  }

  /**
   * A short video of the problem (PO 18/10/2026). Stored privately like the
   * photos and claimed by the booking the same way; nothing sends it to the AI.
   */
  async uploadVideo(
    role: Role,
    ownerUserId: string,
    file?: PrivateBookingPhotoFile,
  ): Promise<PrivateBookingPhotoUploadResponse> {
    if (role !== Role.CUSTOMER) {
      throw new ForbiddenException('Only customers can upload Booking videos');
    }

    const mimeType = this.privateStorage.validateVideo(file);
    const video = file as PrivateBookingPhotoFile;

    let objectRef: string;
    try {
      objectRef = await this.privateStorage.uploadVideo(ownerUserId, video);
    } catch (error) {
      // A video longer than a minute is the customer's to fix (422), not an outage.
      if (error instanceof BusinessException) throw error;
      throw new ServiceUnavailableException('Private Booking video upload is unavailable');
    }

    try {
      const saved = await this.uploadRepository.save(this.uploadRepository.create({
        ownerUserId,
        objectRef,
        mimeType,
        sizeBytes: video.size,
        expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        claimedBookingId: null,
      }));
      return { uploadId: saved.id, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes };
    } catch {
      throw new ServiceUnavailableException('Private Booking video metadata could not be saved');
    }
  }
}

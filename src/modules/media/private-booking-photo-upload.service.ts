import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../../shared/enums';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import {
  PrivateBookingPhotoFile,
  PrivateBookingPhotoStorage,
} from './private-booking-photo-storage.service';

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

export type PrivateBookingPhotoUploadResponse = {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
};

@Injectable()
export class PrivateBookingPhotoUploadService {
  constructor(
    @InjectRepository(PrivateBookingPhotoUpload)
    private readonly uploadRepository: Repository<PrivateBookingPhotoUpload>,
    private readonly privateStorage: PrivateBookingPhotoStorage,
  ) {}

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
}

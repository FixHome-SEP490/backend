// src/modules/media/media.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { OrderEvidenceStorage } from './order-evidence-storage.service';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoUploadService } from './private-booking-photo-upload.service';
import { PrivateBookingPhotoClaimService } from './private-booking-photo-claim.service';

@Module({
  imports: [TypeOrmModule.forFeature([PrivateBookingPhotoUpload])],
  controllers: [MediaController],
  providers: [
    MediaService,
    OrderEvidenceStorage,
    PrivateBookingPhotoStorage,
    PrivateBookingPhotoUploadService,
    PrivateBookingPhotoClaimService,
  ],
  exports: [MediaService, OrderEvidenceStorage, PrivateBookingPhotoStorage, PrivateBookingPhotoClaimService],
})
export class MediaModule {}

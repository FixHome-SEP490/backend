// src/modules/media/media.module.ts
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { OrderEvidenceStorage } from './order-evidence-storage.service';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, OrderEvidenceStorage, PrivateBookingPhotoStorage],
  exports: [MediaService, OrderEvidenceStorage, PrivateBookingPhotoStorage],
})
export class MediaModule {}

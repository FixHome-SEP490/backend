// src/modules/media/media.module.ts
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { OrderEvidenceStorage } from './order-evidence-storage.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, OrderEvidenceStorage],
  exports: [MediaService, OrderEvidenceStorage],
})
export class MediaModule {}

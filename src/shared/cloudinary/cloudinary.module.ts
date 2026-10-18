// src/shared/cloudinary/cloudinary.module.ts
import { Module, Global } from '@nestjs/common';
import { CloudinaryProvider } from './cloudinary.provider';
import { PrivateVideoService } from './private-video.service';
import { MediaStreamTokens } from './media-stream-token.service';

@Global()
@Module({
  providers: [CloudinaryProvider, PrivateVideoService, MediaStreamTokens],
  exports: [CloudinaryProvider, PrivateVideoService, MediaStreamTokens],
})
export class CloudinaryModule {}

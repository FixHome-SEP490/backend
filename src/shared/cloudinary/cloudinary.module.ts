// src/shared/cloudinary/cloudinary.module.ts
import { Module, Global } from '@nestjs/common';
import { CloudinaryProvider } from './cloudinary.provider';

@Global()
@Module({
  providers: [CloudinaryProvider],
  exports: [CloudinaryProvider],
})
export class CloudinaryModule {}

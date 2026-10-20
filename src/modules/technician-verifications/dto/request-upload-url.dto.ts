// src/modules/technician-verifications/dto/request-upload-url.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

export const KYC_UPLOAD_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/webm',
  'video/mp4',
] as const;

export class RequestKycUploadUrlDto {
  @ApiProperty({
    example: 'image/jpeg',
    enum: KYC_UPLOAD_ALLOWED_MIME_TYPES,
    description: 'Allowed MIME types: image/jpeg, image/png, image/webp, application/pdf, video/webm, video/mp4',
  })
  @IsString()
  @IsIn(KYC_UPLOAD_ALLOWED_MIME_TYPES, {
    message: 'mimeType must be one of image/jpeg, image/png, image/webp, application/pdf, video/webm, video/mp4',
  })
  mimeType: string;
}

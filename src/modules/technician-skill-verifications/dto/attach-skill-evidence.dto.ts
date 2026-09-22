// src/modules/technician-skill-verifications/dto/attach-skill-evidence.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

// Technician's own supporting document (e.g. an outside credential). Always
// stored as DocumentType.CERTIFICATE with issuedBy left NULL — the type and
// origin aren't caller-chosen, unlike identity KYC's SubmitVerificationDto.
export class AttachSkillEvidenceDto {
  @ApiProperty({
    example: 'kyc/technician-uuid/opaque-document-id.jpg',
    description:
      'Private Supabase Storage object path from the upload-url step',
  })
  @IsString()
  @IsNotEmpty({ message: 'storageObjectPath is required' })
  @MaxLength(512)
  storageObjectPath: string;

  // Display label only — the real storage key is the server-generated
  // storageObjectPath, so this just needs a sane extension, not a strict
  // charset (real filenames commonly carry parentheses, commas, etc., e.g.
  // "images (2).jpg").
  @ApiProperty({ example: 'chung-chi-dien-lanh.jpg' })
  @IsString()
  @IsNotEmpty({ message: 'fileName is required' })
  @MaxLength(255)
  @Matches(/^[^\\/]+\.(jpe?g|png|webp|pdf)$/iu)
  fileName: string;

  @ApiProperty({ example: 1048576, description: 'File size in bytes (max 10MB)' })
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024, { message: 'fileSize cannot exceed 10MB' })
  fileSize: number;

  @ApiProperty({ example: 'image/jpeg', enum: ALLOWED_MIME_TYPES })
  @IsString()
  @IsIn(ALLOWED_MIME_TYPES, {
    message:
      'mimeType must be one of image/jpeg, image/png, image/webp, application/pdf',
  })
  mimeType: string;
}

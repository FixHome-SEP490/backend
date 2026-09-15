import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, DocumentType, Role, VerificationStatus } from '../../../shared/enums';

export class VerificationUserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'tech@example.com' })
  email: string;

  @ApiProperty({ example: 'Nguyen Van A' })
  fullName: string;

  @ApiProperty({ enum: Role, example: Role.TECHNICIAN })
  role: Role;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.ACTIVE })
  status: AccountStatus;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  avatarUrl?: string | null;
}

export class VerificationDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  verificationId: string;

  @ApiProperty({ enum: DocumentType, example: DocumentType.CITIZEN_ID_FRONT })
  documentType: DocumentType;

  @ApiProperty({ example: 'citizen_id_front.jpg' })
  fileName: string;

  @ApiProperty({ example: 1048576, minimum: 1 })
  fileSize: number;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class TechnicianVerificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  technicianId: string;

  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.PENDING })
  status: VerificationStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reviewedById: string | null;

  @ApiProperty({ type: String, nullable: true })
  rejectionReason: string | null;

  @ApiProperty({ type: [VerificationDocumentResponseDto] })
  documents: VerificationDocumentResponseDto[];

  @ApiPropertyOptional({ type: VerificationUserSummaryDto })
  technician?: VerificationUserSummaryDto;

  @ApiPropertyOptional({ type: VerificationUserSummaryDto, nullable: true })
  reviewedBy?: VerificationUserSummaryDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class KycSignedAccessResponseDto {
  @ApiProperty({
    description:
      'Short-lived private signed access URL. This is not a public URL and must not be persisted or shared.',
    format: 'uri',
  })
  signedUrl: string;

  @ApiProperty({ example: 300, description: 'Access lifetime in seconds.' })
  expiresIn: number;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;
}

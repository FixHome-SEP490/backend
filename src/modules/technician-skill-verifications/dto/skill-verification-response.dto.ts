import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType, VerificationStatus } from '../../../shared/enums';
import { VerificationUserSummaryDto } from '../../technician-verifications/dto';

export class SkillVerificationDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: DocumentType, example: DocumentType.CERTIFICATE })
  documentType: DocumentType;

  @ApiProperty({ example: 'chung-chi-dien-lanh.jpg' })
  fileName: string;

  @ApiProperty({ example: 1048576, minimum: 1 })
  fileSize: number;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'NULL = technician-submitted evidence; set = FixHome-issued certificate',
  })
  issuedById: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class SkillVerificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  technicianSkillId: string;

  @ApiPropertyOptional({ format: 'uuid' })
  technicianId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  serviceId?: string;

  @ApiPropertyOptional({ example: 'Sửa điều hòa không mát' })
  serviceName?: string;

  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.PENDING })
  status: VerificationStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  rejectionReason: string | null;

  @ApiProperty({ type: [SkillVerificationDocumentResponseDto] })
  documents: SkillVerificationDocumentResponseDto[];

  @ApiPropertyOptional({ type: VerificationUserSummaryDto })
  technician?: VerificationUserSummaryDto;

  @ApiPropertyOptional({ type: VerificationUserSummaryDto, nullable: true })
  reviewedBy?: VerificationUserSummaryDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

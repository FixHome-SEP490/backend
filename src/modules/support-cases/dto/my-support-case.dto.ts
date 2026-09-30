import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../shared/dto';
import { SupportCaseStatus, SupportCaseType } from '../../../shared/enums';

export class QueryMySupportCasesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SupportCaseStatus })
  @IsOptional()
  @IsEnum(SupportCaseStatus)
  status?: SupportCaseStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  serviceOrderId?: string;
}

/** Actor-safe view: no manager or creator identifiers. */
export class MySupportCaseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: SupportCaseType })
  caseType: SupportCaseType;

  @ApiProperty({ enum: SupportCaseStatus })
  status: SupportCaseStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  bookingId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  serviceOrderId: string | null;

  @ApiProperty()
  reason: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true })
  resolutionReason: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  evidenceRefs: string[] | null;

  @ApiProperty()
  isUrgent: boolean;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  respondBy: Date | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

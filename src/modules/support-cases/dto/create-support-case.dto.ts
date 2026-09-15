import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportCaseType } from '../../../shared/enums';
import {
  SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
  SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH,
  SUPPORT_CASE_MAX_EVIDENCE_REFS,
  SUPPORT_CASE_MAX_REASON_LENGTH,
} from '../support-case.constants';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimEvidenceRefs = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((ref) => (typeof ref === 'string' ? ref.trim() : ref))
    : value;

/**
 * Bounded escalation request for authenticated Customer/Technician actors.
 * Owner, manager, status, resolution, financial, and state fields are
 * deliberately absent: the global ValidationPipe (whitelist +
 * forbidNonWhitelisted) rejects them and the service derives authoritative
 * ids server-side from CurrentUser and the referenced Booking/ServiceOrder.
 */
export class CreateSupportCaseDto {
  @ApiProperty({
    enum: SupportCaseType,
    description: 'Escalation category for the exception path',
  })
  @IsEnum(SupportCaseType)
  caseType: SupportCaseType;

  @ApiProperty({
    minLength: 1,
    maxLength: SUPPORT_CASE_MAX_REASON_LENGTH,
    example: 'Technician declared a cash amount that does not match my invoice',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(SUPPORT_CASE_MAX_REASON_LENGTH)
  reason: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: SUPPORT_CASE_MAX_DESCRIPTION_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(SUPPORT_CASE_MAX_DESCRIPTION_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: SUPPORT_CASE_MAX_EVIDENCE_REFS,
    maxLength: SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(SUPPORT_CASE_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(trimEvidenceRefs)
  evidenceRefs?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Booking context the case is opened for',
  })
  @IsOptional()
  @IsUUID('4')
  bookingId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Service order context the case is opened for',
  })
  @IsOptional()
  @IsUUID('4')
  serviceOrderId?: string;
}

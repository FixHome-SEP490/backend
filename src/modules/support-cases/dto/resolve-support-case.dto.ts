import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SUPPORT_CASE_FINAL_STATUSES,
  SupportCaseFinalStatus,
  SupportCaseStatus,
} from '../../../shared/enums';
import {
  SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH,
  SUPPORT_CASE_MAX_EVIDENCE_REFS,
  SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
  SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
} from '../support-case.constants';
import { LIABLE_PARTIES } from '../support-case-policy';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimEvidenceRefs = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((ref) => (typeof ref === 'string' ? ref.trim() : ref))
    : value;

export class ResolveSupportCaseDto {
  @ApiProperty({ enum: SUPPORT_CASE_FINAL_STATUSES })
  @IsEnum(SupportCaseStatus)
  @IsIn(SUPPORT_CASE_FINAL_STATUSES)
  finalStatus: SupportCaseFinalStatus;

  @ApiProperty({
    maxLength: SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH,
    example: 'CUSTOMER_CONFIRMED',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(trimString)
  @MaxLength(SUPPORT_CASE_MAX_RESOLUTION_CODE_LENGTH)
  resolutionCode: string;

  @ApiProperty({
    minLength: 10,
    maxLength: SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH,
    example: 'The customer confirmed the resolution after manager review.',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(trimString)
  @MinLength(10)
  @MaxLength(SUPPORT_CASE_MAX_RESOLUTION_REASON_LENGTH)
  reason: string;

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

  @ApiPropertyOptional({ enum: LIABLE_PARTIES, description: 'Recorded for reporting; it triggers no money movement' })
  @IsOptional()
  @IsIn(LIABLE_PARTIES)
  liableParty?: (typeof LIABLE_PARTIES)[number];

  @ApiPropertyOptional({ description: 'Whole VND recorded with the decision; with resolutionCode refund_to_wallet it is credited to the customer wallet' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  amount?: number;
}

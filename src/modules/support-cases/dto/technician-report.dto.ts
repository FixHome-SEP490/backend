import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH, SUPPORT_CASE_MAX_EVIDENCE_REFS } from '../support-case.constants';

export enum TechnicianReportReasonClass {
  SKILL_GAP = 'technician_skill_gap',
  NON_TECHNICIAN = 'non_technician_exception',
}

export enum TechnicianReportReasonCode {
  SKILL_GAP = 'skill_gap',
  DEVICE_TOO_OLD = 'device_too_old',
  SEVERE_DAMAGE = 'severe_damage',
  NO_COMPATIBLE_PART = 'no_compatible_part',
  WARRANTY_OR_WORKSHOP = 'manufacturer_warranty_or_workshop',
  CUSTOMER_ABSENT = 'customer_absent',
  CUSTOMER_CANCELLED = 'customer_cancelled',
  AMBIGUOUS = 'dispute_or_other',
}

export enum TechnicianResponsibility {
  PENDING = 'pending_sm_review',
  TECHNICIAN_FAULT = 'technician_fault',
  NO_TECHNICIAN_FAULT = 'no_technician_fault',
  INCONCLUSIVE = 'inconclusive',
}

export class TechnicianReportDto {
  @ApiPropertyOptional({ enum: ['REPORT_ONLY'], description: 'Informational report; never stops the service' })
  @IsOptional()
  @IsEnum({ REPORT_ONLY: 'REPORT_ONLY' })
  intent?: 'REPORT_ONLY';

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  serviceOrderId: string;

  @ApiProperty({ enum: TechnicianReportReasonClass })
  @IsEnum(TechnicianReportReasonClass)
  reasonClass: TechnicianReportReasonClass;

  @ApiProperty({ enum: TechnicianReportReasonCode })
  @IsEnum(TechnicianReportReasonCode)
  reasonCode: TechnicianReportReasonCode;

  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SUPPORT_CASE_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(({ value }: { value: unknown }) => Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item.trim() : item) : value)
  evidenceRefs?: string[];
}

/** A separate endpoint/command; the legacy report route cannot stop work. */
export class CannotContinueDto extends OmitType(TechnicianReportDto, ['serviceOrderId', 'intent', 'evidenceRefs'] as const) {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId: string;

  @ApiPropertyOptional({ type: [String], maxItems: 3 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsUUID('4', { each: true })
  photoEvidenceIds?: string[];
}

export class DecideTechnicianResponsibilityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  workflowVersion: number;

  @ApiProperty({ enum: [TechnicianResponsibility.TECHNICIAN_FAULT,
    TechnicianResponsibility.NO_TECHNICIAN_FAULT, TechnicianResponsibility.INCONCLUSIVE] })
  @IsEnum(TechnicianResponsibility)
  decision: TechnicianResponsibility;

  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SUPPORT_CASE_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(SUPPORT_CASE_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(({ value }: { value: unknown }) => Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item.trim() : item) : value)
  evidenceRefs?: string[];
}

export function reasonMatchesClass(reasonClass: TechnicianReportReasonClass, reasonCode: TechnicianReportReasonCode): boolean {
  return reasonClass === TechnicianReportReasonClass.SKILL_GAP
    ? reasonCode === TechnicianReportReasonCode.SKILL_GAP
    : reasonClass === TechnicianReportReasonClass.NON_TECHNICIAN &&
      reasonCode !== TechnicianReportReasonCode.SKILL_GAP && Object.values(TechnicianReportReasonCode).includes(reasonCode);
}

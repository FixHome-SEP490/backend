import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../shared/dto';
import {
  WarrantyClaimStatus,
  WarrantyCustomerPrompt,
  WarrantyDeclineReason,
  WarrantyInspectionResult,
  WarrantyNotCoveredReason,
} from '../../../shared/enums';

export const WARRANTY_CLAIM_MIN_TEXT_LENGTH = 10;
export const WARRANTY_CLAIM_MAX_TEXT_LENGTH = 2000;
export const WARRANTY_CLAIM_MAX_EVIDENCE_REFS = 10;
export const WARRANTY_CLAIM_MAX_EVIDENCE_REF_LENGTH = 512;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.trim() : v))
    : value;

export class CreateWarrantyClaimDto {
  @ApiProperty({ format: 'uuid', description: 'Warranty coverage (item) the claim is about' })
  @IsUUID('4')
  warrantyCoverageId: string;

  @ApiProperty({ minLength: WARRANTY_CLAIM_MIN_TEXT_LENGTH, maxLength: WARRANTY_CLAIM_MAX_TEXT_LENGTH })
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  description: string;

  @ApiPropertyOptional({ type: [String], maxItems: WARRANTY_CLAIM_MAX_EVIDENCE_REFS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WARRANTY_CLAIM_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(WARRANTY_CLAIM_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(trimEach)
  evidenceRefs?: string[];
}

export class RespondWarrantyClaimDto {
  @ApiProperty({ enum: ['agree', 'dispute'] })
  @IsIn(['agree', 'dispute'])
  decision: 'agree' | 'dispute';

  @ApiPropertyOptional({ description: 'Required when disputing the decision' })
  @ValidateIf((o: RespondWarrantyClaimDto) => o.decision === 'dispute' || o.note !== undefined)
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH, { message: 'note must contain at least 10 characters' })
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  note?: string;
}

export class WarrantyClaimTechnicianDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  fullName: string;
}

export class WarrantyClaimViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  serviceOrderId: string;

  @ApiProperty({ format: 'uuid' })
  warrantyCoverageId: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  description: string;

  @ApiPropertyOptional({ type: [String], nullable: true })
  evidenceRefs: string[] | null;

  @ApiProperty()
  submittedAfterExpiry: boolean;

  @ApiPropertyOptional({ enum: ['agreed', 'disputed'], nullable: true })
  customerResponse: 'agreed' | 'disputed' | null;

  @ApiPropertyOptional({ enum: WarrantyCustomerPrompt, nullable: true })
  awaitingPrompt: WarrantyCustomerPrompt | null;

  @ApiPropertyOptional({ nullable: true })
  resolutionNotes: string | null;

  @ApiProperty({ format: 'date-time' })
  submittedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiPropertyOptional({ type: WarrantyClaimTechnicianDto, nullable: true })
  technician: WarrantyClaimTechnicianDto | null;
}

export class AcceptWarrantyClaimDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Proposed inspection time' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class DeclineWarrantyClaimDto {
  @ApiProperty({ enum: WarrantyDeclineReason })
  @IsEnum(WarrantyDeclineReason)
  reasonCode: WarrantyDeclineReason;

  @ApiPropertyOptional({ description: 'Required when the reason is "other"' })
  @ValidateIf((o: DeclineWarrantyClaimDto) => o.reasonCode === WarrantyDeclineReason.OTHER || o.note !== undefined)
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  note?: string;
}

export class CheckInWarrantyVisitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  lng?: number;
}

export class ProposeWarrantyInspectionDto {
  @ApiProperty({ enum: WarrantyInspectionResult })
  @IsEnum(WarrantyInspectionResult)
  result: WarrantyInspectionResult;

  @ApiPropertyOptional({ enum: WarrantyNotCoveredReason, description: 'Required when the result is not_covered' })
  @ValidateIf((o: ProposeWarrantyInspectionDto) => o.result === WarrantyInspectionResult.NOT_COVERED)
  @IsEnum(WarrantyNotCoveredReason)
  notCoveredReasonCode?: WarrantyNotCoveredReason;

  @ApiProperty({ minLength: WARRANTY_CLAIM_MIN_TEXT_LENGTH, maxLength: WARRANTY_CLAIM_MAX_TEXT_LENGTH })
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  findings: string;

  @ApiPropertyOptional({ type: [String], description: 'At least one item is required for not_covered' })
  @ValidateIf((o: ProposeWarrantyInspectionDto) => o.result === WarrantyInspectionResult.NOT_COVERED || o.evidenceRefs !== undefined)
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(WARRANTY_CLAIM_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(WARRANTY_CLAIM_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(trimEach)
  evidenceRefs?: string[];
}

export class CompleteWarrantyReServiceDto {
  @ApiProperty({ minLength: WARRANTY_CLAIM_MIN_TEXT_LENGTH, maxLength: WARRANTY_CLAIM_MAX_TEXT_LENGTH })
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  notes: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WARRANTY_CLAIM_MAX_EVIDENCE_REFS)
  @IsString({ each: true })
  @MaxLength(WARRANTY_CLAIM_MAX_EVIDENCE_REF_LENGTH, { each: true })
  @Transform(trimEach)
  evidenceRefs?: string[];
}

export class WarrantyVisitViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  scheduledAt: Date | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  checkedInAt: Date | null;

  @ApiPropertyOptional({ enum: WarrantyInspectionResult, nullable: true })
  proposedResult: WarrantyInspectionResult | null;

  @ApiPropertyOptional({ nullable: true })
  notCoveredReasonCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  findings: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  evidenceRefs: string[] | null;

  @ApiPropertyOptional({ nullable: true })
  reServiceNotes: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  reServiceEvidenceRefs: string[] | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  completedAt: Date | null;
}

export class StaffWarrantyClaimDto extends WarrantyClaimViewDto {
  @ApiProperty()
  order: {
    id: string;
    code: string;
    serviceName: string;
    addressSummary: string;
    customerName: string;
    customerPhone: string;
  };

  @ApiPropertyOptional({ nullable: true })
  coverage: { id: string; itemDescription: string; expiresAt: Date } | null;

  @ApiPropertyOptional({ type: WarrantyVisitViewDto, nullable: true })
  visit: WarrantyVisitViewDto | null;
}

const boolFromQuery = ({ value }: { value: unknown }): unknown =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class QueryWarrantyClaimsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: WarrantyClaimStatus })
  @IsOptional()
  @IsEnum(WarrantyClaimStatus)
  status?: WarrantyClaimStatus;

  @ApiPropertyOptional({ description: 'Only claims that currently have no technician' })
  @IsOptional()
  @Transform(boolFromQuery)
  @IsBoolean()
  unassigned?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  technicianId?: string;
}

export class AssignWarrantyClaimDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  technicianId: string;
}

export class ApproveWarrantyProposalDto {
  @ApiPropertyOptional({ enum: WarrantyInspectionResult, description: 'Overrides the technician proposal' })
  @IsOptional()
  @IsEnum(WarrantyInspectionResult)
  result?: WarrantyInspectionResult;

  @ApiPropertyOptional({ enum: WarrantyNotCoveredReason, description: 'Final reason when not covered' })
  @IsOptional()
  @IsEnum(WarrantyNotCoveredReason)
  reasonCode?: WarrantyNotCoveredReason;

  @ApiPropertyOptional({ description: 'Explanation shown to the customer; required when not covered' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  customerNote?: string;
}

export class RejectWarrantyClaimDto {
  @ApiProperty({ enum: WarrantyNotCoveredReason })
  @IsEnum(WarrantyNotCoveredReason)
  reasonCode: WarrantyNotCoveredReason;

  @ApiProperty({ description: 'Explanation shown to the customer' })
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  customerNote: string;
}

export class CloseWarrantyClaimDto {
  @ApiProperty({ enum: ['resolved', 'rejected'] })
  @IsIn(['resolved', 'rejected'])
  outcome: 'resolved' | 'rejected';

  @ApiPropertyOptional({ description: 'Required unless the customer already agreed' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(WARRANTY_CLAIM_MIN_TEXT_LENGTH)
  @MaxLength(WARRANTY_CLAIM_MAX_TEXT_LENGTH)
  note?: string;
}

export class QueryWarrantyStatsDto {
  @ApiPropertyOptional({ default: 90, minimum: 7, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(365)
  windowDays?: number;
}

export class TechnicianWarrantyStatDto {
  technicianId: string;
  fullName: string;
  ordersWithWarranty: number;
  claims: number;
  claimRate: number | null;
  covered: number;
  notCovered: number;
  notCoveredRate: number | null;
  overridden: number;
  overriddenRate: number | null;
  disputed: number;
  disputedRate: number | null;
  declines: number;
  declineRate: number | null;
  lowSample: boolean;
}

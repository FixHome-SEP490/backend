// src/modules/part-requests/dto/index.ts
import { MAX_PAGE } from '../../../shared/dto/page-size-query.dto';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FulfillmentMethod, PartUsageStatus, PartRequestStatus, PartRequestType } from '../../../shared/enums';
import { IsCanonicalUuid } from '../../../shared/validation/uuid.validators';

// ── Technician: Create Part Request ──

export class CreatePartRequestItemDto {
  @ApiProperty({ format: 'uuid', description: 'Part catalog ID (from FixHome Parts Catalog)' })
  @IsUUID()
  partCatalogId: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;

  @ApiPropertyOptional({ maxLength: 500, description: 'Optional note for this part item' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreatePartRequestDto {
  @ApiProperty({
    type: () => CreatePartRequestItemDto,
    isArray: true,
    minItems: 1,
    maxItems: 50,
    description: 'List of parts to request from FixHome catalog',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreatePartRequestItemDto)
  items: CreatePartRequestItemDto[];

  @ApiPropertyOptional({ enum: FulfillmentMethod, default: FulfillmentMethod.PICKUP })
  @IsOptional()
  @IsEnum(FulfillmentMethod)
  fulfillmentMethod?: FulfillmentMethod;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Reason for requesting parts' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  reason?: string;
}

// ── Technician: Receive via QR scan ──

export class ReceivePartRequestDto {
  @ApiProperty({ description: 'QR token from the part request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  qrToken: string;
}

// ── Technician: Update item usage ──

export class UpdateItemUsageDto {
  @ApiProperty({ enum: [PartUsageStatus.USED, PartUsageStatus.RETURNED] })
  @IsIn([PartUsageStatus.USED, PartUsageStatus.RETURNED])
  usageStatus: PartUsageStatus;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  usedQty?: number;

  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion?: number;

  @IsOptional() @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey?: string;
}

// ── SM: Mark Ready ──

export class MarkReadyDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Optional note from SM' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ── SM: inspect the faulty part of a warranty request ──

export const FAULTY_INSPECTION_RESULTS = ['manufacturer', 'installation', 'undetermined'] as const;
export type FaultyInspectionResult = (typeof FAULTY_INSPECTION_RESULTS)[number];

export class FaultyInspectionDto {
  @ApiProperty({ enum: FAULTY_INSPECTION_RESULTS, description: 'manufacturer and undetermined: FixHome pays the new part; installation: the technician pays' })
  @IsIn(FAULTY_INSPECTION_RESULTS)
  result: FaultyInspectionResult;

  @ApiPropertyOptional({ minLength: 10, maxLength: 2000, description: 'Required for installation' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(10, 2000)
  note?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Photos of the faulty part; required for installation' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  evidenceRefs?: string[];
}

// ── Technician: bring the faulty part of a warranty request back to the warehouse ──

export class FaultyReturnDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Photos of the faulty part handed over' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  evidenceRefs?: string[];
}

// ── SM: Mark Delivering ──

export class MarkDeliveringDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 999999999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999999999)
  shippingFee?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ── Query ──

export class QueryPartRequestsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(PartRequestStatus)
  status?: PartRequestStatus;

  @IsOptional()
  @IsEnum(PartRequestType)
  requestType?: PartRequestType;

  @IsOptional()
  @IsEnum(FulfillmentMethod)
  fulfillmentMethod?: FulfillmentMethod;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  serviceOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCanonicalUuid()
  technicianId?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CancelPartRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

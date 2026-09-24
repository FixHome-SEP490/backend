// src/modules/part-requests/dto/index.ts
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FulfillmentMethod, PartUsageStatus } from '../../../shared/enums';

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
  qrToken: string;
}

// ── Technician: Update item usage ──

export class UpdateItemUsageDto {
  @ApiProperty({ enum: [PartUsageStatus.USED, PartUsageStatus.RETURNED] })
  @IsEnum(PartUsageStatus)
  usageStatus: PartUsageStatus;
}

// ── SM: Mark Ready ──

export class MarkReadyDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Optional note from SM' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
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
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  serviceOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

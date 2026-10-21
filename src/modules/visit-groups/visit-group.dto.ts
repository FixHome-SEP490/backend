import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { UrgencyLevel } from '../../shared/enums';
import { BookingDeviceAttributesDto, UUID_REGEX } from '../bookings/booking.dto';

/** The self-service limit (PO 21/10/2026); the database also caps `sequence` at 3. */
export const VISIT_GROUP_DEVICE_LIMIT = 3;

export class VisitGroupItemDto {
  @ApiProperty({ format: 'uuid', description: 'Catalog service for this one physical device.' })
  @Matches(UUID_REGEX, { message: 'serviceId must be a valid UUID' })
  serviceId: string;

  @ApiPropertyOptional({ maxLength: 80, example: 'Máy lạnh phòng ngủ', description: 'What the customer calls this device.' })
  @IsOptional() @IsString() @MaxLength(80)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  deviceLabel?: string;

  @ApiPropertyOptional({ maxLength: 5000, description: 'This device\'s fault. Optional for a firm price, required for a job quoted on site (same rule as POST /bookings).' })
  @IsOptional() @IsString() @MaxLength(5000)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  description?: string;

  @ApiPropertyOptional({ type: () => BookingDeviceAttributesDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => BookingDeviceAttributesDto)
  deviceAttributes?: BookingDeviceAttributesDto | null;

  @ApiPropertyOptional({ description: 'Approved Catalog V2 variant code confirmed by GET /services/:id/catalog-v2-pricing.' })
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/)
  selectedVariantCode?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 7, description: 'Private upload IDs for this device only.' })
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each photo upload ID must be a valid UUID' })
  photoUploadIds?: string[];
}

export class CreateVisitGroupDto {
  @ApiProperty({ format: 'uuid', description: 'Saved address shared by every device.' })
  @Matches(UUID_REGEX, { message: 'addressId must be a valid UUID' })
  addressId: string;

  @ApiPropertyOptional({ enum: ['scheduled', 'urgent'] })
  @IsOptional() @IsIn(['scheduled', 'urgent'])
  mode?: 'scheduled' | 'urgent';

  @ApiPropertyOptional({ example: '2030-10-21' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ enum: ['morning', 'afternoon', 'evening'] })
  @IsOptional() @IsIn(['morning', 'afternoon', 'evening'])
  slot?: 'morning' | 'afternoon' | 'evening';

  @IsOptional() @IsDateString() preferredStartAt?: string;
  @IsOptional() @IsDateString() preferredEndAt?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000)
  customerNote?: string;

  @IsOptional() @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  @ApiPropertyOptional({ maxLength: 128, description: 'Retrying with the same key returns the first group.' })
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{8,128}$/, { message: 'idempotencyKey must be 8 to 128 letters, digits, - or _' })
  idempotencyKey?: string;

  @ApiProperty({ type: [VisitGroupItemDto], minItems: 1, description: `One entry per physical device. More than ${VISIT_GROUP_DEVICE_LIMIT} is refused with VISIT_GROUP_DEVICE_LIMIT (422); GET /visit-groups/contact gives the hotline.` })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => VisitGroupItemDto)
  items: VisitGroupItemDto[];
}

/** A request for help from a customer with more devices than one visit takes. */
export class VisitGroupConsultationDto {
  @ApiProperty({ minLength: 1, maxLength: 1000, example: 'Nhà có 5 máy lạnh cần vệ sinh' })
  @IsString() @MinLength(1) @MaxLength(1000)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  message: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20, description: 'Device names from the customer\'s draft, kept so nobody asks again.' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true })
  devices?: string[];
}

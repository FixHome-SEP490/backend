import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { BookingDeviceAttributesDto, UUID_REGEX } from '../booking.dto';

export class RepairFailureRebookItemDto {
  @Matches(UUID_REGEX) sourceBookingId: string;
  @Matches(UUID_REGEX) sourceIncidentId: string;
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/) selectedVariantCode?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => BookingDeviceAttributesDto) deviceAttributes?: BookingDeviceAttributesDto | null;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ArrayUnique() @Matches(UUID_REGEX, { each: true }) photoUploadIds?: string[];
}

export class RepairFailureRebookDto {
  @Matches(/^[A-Za-z0-9_-]{8,128}$/) idempotencyKey: string;
  @Matches(UUID_REGEX) addressId: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsIn(['morning', 'afternoon', 'evening']) slot: 'morning' | 'afternoon' | 'evening';
  @IsOptional() @IsString() @MaxLength(1000)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  customerNote?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3)
  @ValidateNested({ each: true }) @Type(() => RepairFailureRebookItemDto)
  items: RepairFailureRebookItemDto[];
}

import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateBy, ValidateIf, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BookingDeviceAttributesDto, UUID_REGEX } from '../booking.dto';

/** Shared by HTTP validation and internal confirmation; urgent never accepts a client window. */
export function validInterruptionRebookSchedule(input: { mode?: unknown; date?: unknown; slot?: unknown }): boolean {
  if (input.mode === 'urgent') return input.date === undefined && input.slot === undefined;
  return (input.mode === undefined || input.mode === 'scheduled')
    && typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
    && ['morning', 'afternoon', 'evening'].includes(input.slot as string);
}

export class InterruptionRebookItemDto {
  @Matches(UUID_REGEX) sourceBookingId: string;
  @Matches(UUID_REGEX) sourceCaseId: string;
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/) selectedVariantCode?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => BookingDeviceAttributesDto) deviceAttributes?: BookingDeviceAttributesDto | null;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ArrayUnique() @Matches(UUID_REGEX, { each: true }) photoUploadIds?: string[];
}

export class InterruptionRebookDto {
  @Matches(/^[A-Za-z0-9_-]{8,128}$/) idempotencyKey: string;
  @Matches(UUID_REGEX) addressId: string;
  @ApiPropertyOptional({ enum: ['scheduled', 'urgent'], description: 'Omitted: scheduled (legacy). Urgent requires date and slot to be omitted; the server computes the normal come-now window.' })
  @ValidateBy({ name: 'interruptionRebookSchedule', validator: {
    validate: (_value, args) => validInterruptionRebookSchedule(args.object as InterruptionRebookDto),
    defaultMessage: () => 'Hẹn lịch cần ngày và buổi; tới ngay không được gửi ngày hoặc buổi.',
  } })
  mode?: 'scheduled' | 'urgent';
  @ValidateIf(dto => dto.mode !== 'urgent')
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @ValidateIf(dto => dto.mode !== 'urgent')
  @IsIn(['morning', 'afternoon', 'evening']) slot?: 'morning' | 'afternoon' | 'evening';
  @IsOptional() @IsString() @MaxLength(1000)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  customerNote?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3)
  @ValidateNested({ each: true }) @Type(() => InterruptionRebookItemDto)
  items: InterruptionRebookItemDto[];
}

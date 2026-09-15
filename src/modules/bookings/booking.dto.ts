import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { UrgencyLevel } from '../../shared/enums';

export class ScheduleBookingDto {
  @IsDateString() preferredStartAt: string;
  @IsDateString() preferredEndAt: string;
}

export class CreateBookingDto extends ScheduleBookingDto {
  @IsUUID() serviceId: string;
  @IsUUID() addressId: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(5000) description: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
  @IsOptional() @IsEnum(UrgencyLevel) urgency?: UrgencyLevel;
}

export class RebookDto extends ScheduleBookingDto {
  @IsOptional() @IsString() @MaxLength(5000) problemDescription?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
}

export class ShortlistDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ArrayUnique()
  @IsUUID('all', { each: true }) technicianIds: string[];
}

export class InvitationResponseDto {
  @IsIn(['ACCEPT', 'DECLINE']) action: 'ACCEPT' | 'DECLINE';
}

export function validBookingWindow(start: string | Date, end: string | Date): boolean {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && from > Date.now() && from < to;
}

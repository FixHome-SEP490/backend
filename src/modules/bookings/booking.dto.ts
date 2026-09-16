import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { UrgencyLevel } from '../../shared/enums';

export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ScheduleBookingDto {
  @IsDateString() preferredStartAt: string;
  @IsDateString() preferredEndAt: string;
}

export class CreateBookingDto extends ScheduleBookingDto {
  @Matches(UUID_REGEX, { message: 'serviceId must be a valid UUID' })
  serviceId: string;

  @Matches(UUID_REGEX, { message: 'addressId must be a valid UUID' })
  addressId: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(5000)
  description: string;

  @IsOptional() @IsInt() @Min(1) @Max(1000)
  quantity?: number;

  @IsOptional() @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  @IsOptional() @IsArray() @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional() @Matches(UUID_REGEX, { message: 'aiDiagnosisId must be a valid UUID' })
  aiDiagnosisId?: string;
}

export class RebookDto extends ScheduleBookingDto {
  @IsOptional() @IsString() @MaxLength(5000) problemDescription?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
}

export class ShortlistDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each technician ID must be a valid UUID' })
  technicianIds: string[];
}

export class InvitationResponseDto {
  @IsIn(['ACCEPT', 'DECLINE']) action: 'ACCEPT' | 'DECLINE';
}

export function validBookingWindow(start: string | Date, end: string | Date): boolean {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && from > Date.now() && from < to;
}

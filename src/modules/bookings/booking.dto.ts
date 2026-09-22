import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { UrgencyLevel } from '../../shared/enums';

export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ScheduleBookingDto {
  @IsDateString() preferredStartAt: string;
  @IsDateString() preferredEndAt: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MaxLength(5000)
  description?: string;
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

  /** Legacy public URLs remain accepted during rollout and are not private media. */
  @IsOptional() @IsArray() @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(5) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each photo upload ID must be a valid UUID' })
  photoUploadIds?: string[];

  @IsOptional() @Matches(UUID_REGEX, { message: 'aiDiagnosisId must be a valid UUID' })
  aiDiagnosisId?: string;
}

export class AttachBookingMediaDto {
  @Matches(/^https?:\/\/\S+$/i, { message: 'url must be an HTTP(S) legacy public media URL' })
  url: string;

  @IsOptional() @IsString() @MaxLength(64)
  mimeType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  sizeBytes?: number;
}

export class RebookDto extends ScheduleBookingDto {
  @IsOptional() @IsString() @MaxLength(5000) problemDescription?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
}

export class ShortlistDto {
  @ApiProperty({
    type: [String], minItems: 2, maxItems: 2, uniqueItems: true,
    description: 'Exactly two distinct technician USER IDs in customer priority order. Only #1 is invited initially; #2 remains STANDBY until #1 declines or expires. Do not send TechnicianProfile IDs.',
    example: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  })
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(2) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each technician ID must be a valid UUID' })
  technicianIds: string[];
}

export class InvitationResponseDto {
  @ApiProperty({ enum: ['ACCEPT', 'DECLINE'], example: 'DECLINE', description: 'Only a live PENDING invitation may be answered. DECLINE activates the next eligible standby technician; ACCEPT creates one ServiceOrder.' })
  @IsIn(['ACCEPT', 'DECLINE']) action: 'ACCEPT' | 'DECLINE';
}
export function validBookingWindow(start: string | Date, end: string | Date): boolean {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && from > Date.now() && from < to;
}

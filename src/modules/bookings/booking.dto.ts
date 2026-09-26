import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { UrgencyLevel } from '../../shared/enums';

export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ScheduleBookingDto {
  @ApiProperty({ format: 'date-time', example: '2030-10-21T08:00:00.000Z', description: 'Preferred arrival-window start: ISO 8601 with timezone, future date.' })
  @IsDateString() preferredStartAt: string;
  @ApiProperty({ format: 'date-time', example: '2030-10-21T10:00:00.000Z', description: 'Preferred arrival-window end: later than preferredStartAt.' })
  @IsDateString() preferredEndAt: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiPropertyOptional({ maxLength: 5000, description: 'Optional problem-description update when rescheduling.' })
  @IsString() @MaxLength(5000)
  description?: string;
}

export class CreateBookingDto extends ScheduleBookingDto {
  @ApiProperty({ format: 'uuid', example: '11111111-1111-4111-8111-111111111111', description: 'Service ID from catalog.' })
  @Matches(UUID_REGEX, { message: 'serviceId must be a valid UUID' })
  serviceId: string;

  @ApiProperty({ format: 'uuid', example: '22222222-2222-4222-8222-222222222222', description: 'ID of the customer saved repair address.' })
  @Matches(UUID_REGEX, { message: 'addressId must be a valid UUID' })
  addressId: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiProperty({ required: true, maxLength: 5000, example: 'Thiết bị không hoạt động', description: 'Required problem description for a new Booking.' })
  @IsString() @IsNotEmpty() @MaxLength(5000)
  description: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, example: 1, description: 'Number of units for this service, especially for fixed-price services.' })
  @IsOptional() @IsInt() @Min(1) @Max(1000)
  quantity?: number;

  @ApiPropertyOptional({ enum: UrgencyLevel, example: UrgencyLevel.MEDIUM, description: 'Backend values low, medium, high, critical; defaults to medium if omitted.' })
  @IsOptional() @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  /** Legacy public URLs remain accepted during rollout and are not private media. */
  @ApiPropertyOptional({ type: [String], description: 'Legacy PUBLIC media URLs, not private images. Prefer photoUploadIds.' })
  @IsOptional() @IsArray() @IsString({ each: true })
  mediaUrls?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 5, uniqueItems: true, description: 'Up to five PRIVATE booking PHOTO upload UUIDs; distinct from the one-or-two technician shortlist IDs.' })
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each photo upload ID must be a valid UUID' })
  photoUploadIds?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Optional linked AI diagnosis ID.' })
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
    type: [String], minItems: 1, maxItems: 2, uniqueItems: true,
    description: 'One or two distinct technician USER IDs in customer priority order. #1 is invited immediately; when #2 exists it remains STANDBY until #1 declines or expires. Do not send TechnicianProfile IDs.',
    example: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @ArrayUnique()
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

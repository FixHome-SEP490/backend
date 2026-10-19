import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { CatalogV2DeviceAttributes } from '../../database/catalog-v2/catalog-v2-device-attributes';
import { UrgencyLevel } from '../../shared/enums';

export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ScheduleBookingDto {
  @ApiPropertyOptional({ enum: ['scheduled', 'urgent'], description: 'scheduled = one session of a day (date + slot); urgent = come now. Omitted: the legacy preferredStartAt/preferredEndAt window is used.' })
  @IsOptional() @IsIn(['scheduled', 'urgent'])
  mode?: 'scheduled' | 'urgent';

  @ApiPropertyOptional({ example: '2030-10-21', description: 'Vietnam calendar day of a scheduled booking (YYYY-MM-DD).' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ enum: ['morning', 'afternoon', 'evening'], description: 'Vietnam arrival sessions: morning 08:00-12:00, afternoon 13:00-18:00, evening 18:00-23:00. Evening alone may be booked after its start, until strictly before 23:00; arrival starts at max(now, 18:00). No repair-completion guarantee. Urgent remains now + configured minutes, even across midnight.' })
  @IsOptional() @IsIn(['morning', 'afternoon', 'evening'])
  slot?: 'morning' | 'afternoon' | 'evening';

  @ApiPropertyOptional({ format: 'date-time', example: '2030-10-21T08:00:00.000Z', description: 'Legacy arrival-window start (ISO 8601). Ignored when mode is given.' })
  @IsOptional() @IsDateString() preferredStartAt?: string;
  @ApiPropertyOptional({ format: 'date-time', example: '2030-10-21T10:00:00.000Z', description: 'Legacy arrival-window end.' })
  @IsOptional() @IsDateString() preferredEndAt?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiPropertyOptional({ maxLength: 5000, description: 'Optional problem-description update when rescheduling.' })
  @IsString() @MaxLength(5000)
  description?: string;
}

export class BookingDeviceAttributesDto implements CatalogV2DeviceAttributes {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiPropertyOptional({ maxLength: 64, description: 'Optional device brand supplied by the customer.' })
  @IsOptional() @IsString() @MaxLength(64)
  brand?: string;

  @ApiPropertyOptional({ enum: ['wall', 'ceiling', 'unknown'] })
  @IsOptional() @IsIn(['wall', 'ceiling', 'unknown'])
  acMounting?: 'wall' | 'ceiling' | 'unknown';

  @ApiPropertyOptional({ enum: ['up_to_1_5', '2_to_2_5', 'unknown'] })
  @IsOptional() @IsIn(['up_to_1_5', '2_to_2_5', 'unknown'])
  acHorsepower?: 'up_to_1_5' | '2_to_2_5' | 'unknown';

  @ApiPropertyOptional({ enum: ['top', 'front', 'unknown'] })
  @IsOptional() @IsIn(['top', 'front', 'unknown'])
  washerLoadingStyle?: 'top' | 'front' | 'unknown';

  @ApiPropertyOptional({ minimum: 0.1, maximum: 50, description: 'Optional washer capacity in kg; omitted or null means unknown.' })
  @IsOptional() @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 1 }) @Min(0.1) @Max(50)
  washerCapacityKg?: number | null;
}

export class CreateBookingDto extends ScheduleBookingDto {
  @ApiPropertyOptional({ description: 'Approved Catalog V2 variant code. Selecting it confirms its named work scope; AC/WM still require sufficient device facts.' })
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/)
  selectedVariantCode?: string | null;

  @ApiPropertyOptional({ description: 'Alias of selectedVariantCode for the initial cross-team contract. When both are sent they must match.' })
  @IsOptional() @Matches(/^[A-Z]{2}-\d{2}-\d{2}$/)
  variantCode?: string | null;

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

  @ApiPropertyOptional({ type: [String], maxItems: 7, uniqueItems: true, description: 'PRIVATE booking upload UUIDs: up to five photos (POST /media/booking-photo-upload) and up to two videos (POST /media/booking-video-upload); distinct from the one-or-two technician shortlist IDs.' })
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ArrayUnique()
  @Matches(UUID_REGEX, { each: true, message: 'Each photo upload ID must be a valid UUID' })
  photoUploadIds?: string[];

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiPropertyOptional({ maxLength: 1000, example: 'Gọi trước khi đến, nhà trong hẻm', description: 'Note for the technician, apart from the problem description.' })
  @IsOptional() @IsString() @MaxLength(1000)
  customerNote?: string;

  @ApiPropertyOptional({ type: () => BookingDeviceAttributesDto, description: 'Optional customer-reported device facts. The server validates them against the selected service and derives any Catalog V2 preview itself.' })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => BookingDeviceAttributesDto)
  deviceAttributes?: BookingDeviceAttributesDto | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Optional linked AI diagnosis ID.' })
  @IsOptional() @Matches(UUID_REGEX, { message: 'aiDiagnosisId must be a valid UUID' })
  aiDiagnosisId?: string;

  @ApiPropertyOptional({ maxLength: 128, description: 'Session id returned by POST /ai/chat/ask or /ai/diagnoses. The booking keeps a summary of that conversation for the technician; an unknown or foreign session is ignored.' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{1,128}$/, { message: 'aiSessionId must be the session id returned by the assistant' })
  aiSessionId?: string;
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
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @MaxLength(1000) customerNote?: string;
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
  // 2-minute buffer for network transmission and client-server clock skew
  return Number.isFinite(from) && Number.isFinite(to) && from > (Date.now() - 120_000) && from < to;
}

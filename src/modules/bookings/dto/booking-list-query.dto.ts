import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { CsvToArray } from '../../../shared/utils/list-search';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { BookingStatus } from '../../../shared/enums';
import { REQUEST_STAGES, type RequestStage } from '../../../shared/utils/customer-activity-stage';

export class BookingListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ description: 'Several states at once, comma separated' })
  @IsOptional()
  @CsvToArray()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEnum(BookingStatus, { each: true })
  statuses?: BookingStatus[];

  @ApiPropertyOptional({ enum: REQUEST_STAGES, description: 'Customer list only: no_technician (closed, or the order lost its technician), sent (still searching), cancelled' })
  @IsOptional()
  @IsIn(REQUEST_STAGES)
  stage?: RequestStage;

  @ApiPropertyOptional({ description: 'Service name or description contains (accents ignored)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'true: the appointment has passed; false: not yet' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ enum: ['created', 'appointment'], description: 'created: newest first (default); appointment: earliest appointment first' })
  @IsOptional()
  @IsIn(['created', 'appointment'])
  sort?: 'created' | 'appointment';
}

/** Customer list opt-in; legacy booking-list callers keep their existing result set. */
export class MyBookingListQueryDto extends BookingListQueryDto {
  @ApiPropertyOptional({ description: 'Exclude bookings that belong to a multi-device visit', default: false })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  excludeVisitGroups?: boolean;
}

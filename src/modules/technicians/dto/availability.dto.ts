import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ServiceAreaItemDto } from './onboarding.dto';
import { NoUnsafeText } from '../../../shared/validation/text.validators';

/** 24-hour "HH:mm"; the column holds five characters. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ScheduleItemDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = Sunday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '08:00' })
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'startTime must be HH:mm' })
  startTime: string;

  @ApiProperty({ example: '17:00' })
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'endTime must be HH:mm' })
  endTime: string;
}

export class UpdateScheduleDto {
  @ApiProperty({ type: [ScheduleItemDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules: ScheduleItemDto[];
}

export class UpdateServiceAreasDto {
  @ApiProperty({ type: [ServiceAreaItemDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ServiceAreaItemDto)
  areas: ServiceAreaItemDto[];
}

export class CreateTimeOffDto {
  @ApiProperty({ example: '2026-10-20T00:00:00+07:00' })
  @IsDateString()
  startAt: string;

  @ApiProperty({ example: '2026-10-21T00:00:00+07:00' })
  @IsDateString()
  endAt: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @NoUnsafeText()
  reason?: string;
}

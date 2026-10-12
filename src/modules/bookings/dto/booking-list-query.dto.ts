import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { CsvToArray } from '../../../shared/utils/list-search';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { BookingStatus } from '../../../shared/enums';

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

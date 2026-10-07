import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_SIZE } from '../constants';

/** Highest page any list accepts; past it the SQL OFFSET overflows. */
export const MAX_PAGE = 1_000_000;

/**
 * Paging for the lists that take `page` and `pageSize` (bookings, orders,
 * repair history, cancellations, strikes, reviews). Same bounds as
 * PaginationDto, so a negative, non-numeric or huge value is a 400 rather
 * than a negative OFFSET or an overflow surfacing as a 500.
 */
export class PageSizeQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = 20;
}

/** Same bounds for the lists that call their page size `limit`. */
export class PageLimitQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 20;
}

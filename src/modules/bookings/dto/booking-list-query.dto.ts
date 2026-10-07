import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { BookingStatus } from '../../../shared/enums';

export class BookingListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

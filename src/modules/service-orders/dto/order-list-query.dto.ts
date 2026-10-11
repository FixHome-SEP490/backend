import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CsvToArray } from '../../../shared/utils/list-search';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { ServiceOrderStatus } from '../../../shared/enums';

export class OrderListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: ServiceOrderStatus })
  @IsOptional()
  @IsEnum(ServiceOrderStatus)
  status?: ServiceOrderStatus;

  @ApiPropertyOptional({ description: 'Several states at once, comma separated (e.g. accepted,en_route)' })
  @IsOptional()
  @CsvToArray()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEnum(ServiceOrderStatus, { each: true })
  statuses?: ServiceOrderStatus[];

  @ApiPropertyOptional({ description: 'Order code, service or customer name contains (accents ignored)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class OrderBoardQueryDto extends OrderListQueryDto {}

export class StrikeListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

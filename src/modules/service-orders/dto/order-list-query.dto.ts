import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { ServiceOrderStatus } from '../../../shared/enums';

export class OrderListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: ServiceOrderStatus })
  @IsOptional()
  @IsEnum(ServiceOrderStatus)
  status?: ServiceOrderStatus;
}

export class OrderBoardQueryDto extends OrderListQueryDto {
  @ApiPropertyOptional({ description: 'Order code contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class StrikeListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

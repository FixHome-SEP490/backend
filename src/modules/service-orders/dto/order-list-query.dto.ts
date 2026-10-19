import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CsvToArray } from '../../../shared/utils/list-search';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { ServiceOrderStatus } from '../../../shared/enums';
import { REPAIR_STAGES, type RepairStage } from '../../../shared/utils/customer-activity-stage';

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

  @ApiPropertyOptional({ enum: REPAIR_STAGES, description: 'Customer list only: in_progress (a technician holds the order), completed, cancelled' })
  @IsOptional()
  @IsIn(REPAIR_STAGES)
  stage?: RepairStage;

  @ApiPropertyOptional({ description: 'Order code, service, customer or technician name contains (accents ignored)' })
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

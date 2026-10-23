import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
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

/** Customer and technician personal list opt-in; the staff board keeps the legacy result set. */
export class MyOrderListQueryDto extends OrderListQueryDto {
  @ApiPropertyOptional({ description: 'Exclude service orders that belong to a multi-device visit', default: false })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  excludeVisitGroups?: boolean;
}

export class OrderBoardQueryDto extends OrderListQueryDto {}

export class StrikeListQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
